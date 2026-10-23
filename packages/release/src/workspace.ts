import { execFile as execFileCb } from "node:child_process";
import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isRecord } from "@repo/utils/is-record";
import { sortedNames } from "@repo/utils/sorted-names";

import type { Repository } from "./manifest.ts";
import type { Source } from "./sources.ts";
import { parseVersion } from "./versions.ts";

// The packages the sources build, as their builds wrote them.

export const SCOPE = "@govuk-once/";

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly [field: string]: unknown;
}

export interface Workspace {
  readonly root: string;
  readonly sources: readonly Source[];
  /** Runs each source's build script in the given directories. Tests stand in for it. */
  readonly build?: (
    root: string,
    sources: readonly Source[],
    directories: readonly string[],
  ) => Promise<void>;
}

export interface Publishable {
  readonly source: Source;
  /** The workspace package's directory, from the workspace root, with forward slashes. */
  readonly directory: string;
  /** Where the build wrote the package. */
  readonly builtDir: string;
  readonly built: Manifest;
}

export const nameOf = (pkg: Publishable): string => pkg.built.name;

export async function readManifest(file: string): Promise<Manifest> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== "string" ||
    typeof parsed.version !== "string"
  ) {
    throw new Error(`${file} names no package and version.`);
  }
  return parsed as Manifest;
}

export function sourceDirectories(root: string, source: Source): string[] {
  return sortedNames(
    new Set(
      source.directories.flatMap((pattern) =>
        globSync(`${pattern}/package.json`, { cwd: root }).map((file) =>
          path.posix.dirname(file.split(path.sep).join("/")),
        ),
      ),
    ),
  );
}

const execFile = promisify(execFileCb);

// What a command wrote before it failed, from the error execFile rejects with.
export function outputOf(error: unknown): string {
  if (!isRecord(error)) return "";
  const { stdout, stderr } = error;
  return [stdout, stderr]
    .map((text) => (typeof text === "string" ? text : ""))
    .join("")
    .trimEnd();
}

async function buildSources(
  root: string,
  sources: readonly Source[],
  directories: readonly string[],
): Promise<void> {
  for (const source of sources) {
    const filters = sourceDirectories(root, source)
      .filter((d) => directories.includes(d))
      .flatMap((d) => ["--filter", `./${d}`]);
    if (filters.length === 0) continue;
    try {
      await execFile("pnpm", [...filters, "run", source.script], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`${source.script} failed.\n${outputOf(error)}`, {
        cause: error,
      });
    }
  }
}

// Builds the sources' packages, or those in the given directories, and reads each as its build
// wrote it.
export async function buildWorkspace(
  workspace: Workspace,
  only?: ReadonlySet<string>,
): Promise<Publishable[]> {
  const { root, sources } = workspace;
  const directories = sources
    .flatMap((source) => sourceDirectories(root, source))
    .filter((d) => only?.has(d) ?? true);
  await (workspace.build ?? buildSources)(root, sources, directories);
  const found: Publishable[] = [];
  for (const source of sources) {
    for (const directory of sourceDirectories(root, source)) {
      if (!directories.includes(directory)) continue;
      const builtDir = path.join(root, directory, source.output);
      const built = await readManifest(
        path.join(builtDir, "package.json"),
      ).catch(() => {
        throw new Error(
          `${directory} has no package in ${source.output}/ after its ${source.script} script.`,
        );
      });
      if (!built.name.startsWith(SCOPE)) {
        throw new Error(
          `${directory} builds ${built.name}, which is not in ${SCOPE}.`,
        );
      }
      parseVersion(built.version);
      if (source.versioning === "declared") {
        const own = await readManifest(
          path.join(root, directory, "package.json"),
        );
        if (own.name !== built.name || own.version !== built.version) {
          throw new Error(
            `${directory} builds ${built.name}@${built.version}, not itself, ${own.name}@${own.version}.`,
          );
        }
      }
      found.push({ source, directory, builtDir, built });
    }
  }
  const names = found.map(nameOf);
  const repeated = names.find((name, i) => names.indexOf(name) !== i);
  if (repeated !== undefined) {
    throw new Error(`More than one directory builds ${repeated}.`);
  }
  return found;
}

// The repository each package is published from, from the workspace root's manifest.
export async function repositoryOf(root: string): Promise<Repository> {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf-8"),
  );
  const repository = isRecord(manifest) ? manifest.repository : undefined;
  if (
    !isRecord(repository) ||
    typeof repository.type !== "string" ||
    typeof repository.url !== "string"
  ) {
    throw new Error("The workspace's package.json names no repository.");
  }
  return { type: repository.type, url: repository.url };
}

// Each declared package's version, from its own manifest, built or not. A `workspace:` link to
// it is published as this version.
export async function declaredVersions(
  workspace: Workspace,
): Promise<Map<string, string>> {
  const { root, sources } = workspace;
  const manifests = await Promise.all(
    sources
      .filter((source) => source.versioning === "declared")
      .flatMap((source) => sourceDirectories(root, source))
      .map((d) => readManifest(path.join(root, d, "package.json"))),
  );
  return new Map(manifests.map(({ name, version }) => [name, version]));
}

// The other published packages a package names in its manifest.
export function dependenciesOf(
  pkg: Publishable,
  among: ReadonlySet<string>,
): string[] {
  return sortedNames(
    new Set(
      DEPENDENCY_FIELDS.flatMap((field) => {
        const deps = pkg.built[field];
        return isRecord(deps)
          ? Object.keys(deps).filter((n) => among.has(n))
          : [];
      }),
    ),
  );
}

// The packages in an order where each comes after the ones it depends on, so a dependency is
// always published first.
export function dependencyOrder(pkgs: readonly Publishable[]): Publishable[] {
  const byName = new Map(pkgs.map((pkg) => [nameOf(pkg), pkg]));
  const names = new Set(byName.keys());
  const ordered: Publishable[] = [];
  const visiting = new Set<string>();
  const visit = (name: string) => {
    const pkg = byName.get(name);
    if (pkg === undefined || ordered.includes(pkg)) return;
    if (visiting.has(name)) throw new Error(`${name} depends on itself.`);
    visiting.add(name);
    for (const dep of dependenciesOf(pkg, names)) visit(dep);
    visiting.delete(name);
    ordered.push(pkg);
  };
  for (const name of sortedNames(names)) visit(name);
  return ordered;
}

// The packages a release, or a merge's candidates, must hold besides those it starts from, and
// why. One that depends on a package released names its new version once built again, so it is
// released too. A package with unreleased changes that a released one depends on was built into
// it, so it is released too.
export function lockedIn(
  pkgs: readonly Publishable[],
  chosen: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): Map<string, string> {
  const releasing = new Set(chosen);
  const locked = new Map<string, string>();
  const lock = (name: string, why: string) => {
    releasing.add(name);
    locked.set(name, why);
  };
  for (let added = true; added;) {
    added = false;
    for (const pkg of pkgs) {
      const name = nameOf(pkg);
      if (releasing.has(name)) {
        for (const dep of dependenciesOf(pkg, pending)) {
          if (releasing.has(dep)) continue;
          lock(dep, `${name} depends on it`);
          added = true;
        }
      } else {
        const [dep] = dependenciesOf(pkg, releasing);
        if (dep === undefined) continue;
        lock(name, `depends on ${dep}`);
        added = true;
      }
    }
  }
  return locked;
}
