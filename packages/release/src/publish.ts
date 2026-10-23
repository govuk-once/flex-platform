import { execFile as execFileCb } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isRecord } from "@repo/utils/is-record";

import { publishedManifest } from "./manifest.ts";
import { packPackage, tarballName } from "./package.ts";
import { readRecord, RECORD_FILE } from "./record.ts";
import { buildsAsRecorded, statusesOf } from "./status.ts";
import { candidateVersion } from "./versions.ts";
import {
  buildWorkspace,
  declaredVersions,
  dependenciesOf,
  dependencyOrder,
  nameOf,
  type Publishable,
  repositoryOf,
  type Workspace,
} from "./workspace.ts";

// What the pipeline runs on main. Nothing is published that a release did not record:
// `packRelease` packs each recorded version the registry does not have yet, into a directory the
// pipeline keeps for the run, and `publishRelease` publishes one stage of it. The `merge` stage
// goes out as the run starts: the finals of what is released as it merges, such as the client,
// and a candidate of each gateway's package, which stands in for its final until production
// serves it. The `production` stage goes out then: the finals of the gateways' packages, each the
// same build as its candidate, under its own version, so what is published is what was tested.
//
// Each run publishes whatever is missing, so a run that was dropped or failed is made up by the
// next, and running one again changes nothing.

export const PLAN_FILE = "plan.json";

export type Stage = "merge" | "production";

export interface Packed {
  readonly name: string;
  readonly version: string;
  /** The tarball, from the directory the plan is in. */
  readonly file: string;
  /** A candidate goes out under `rc`, never `latest`, since a publish moves `latest` to it. */
  readonly tag: "rc" | "latest";
}

/** A recorded version not packed, and why. */
export interface Withheld {
  readonly name: string;
  readonly version: string;
  readonly reason: string;
}

export type Plan = Readonly<Record<Stage, readonly Packed[]>> & {
  readonly withheld: readonly Withheld[];
};

export interface PackOptions {
  /** The directory the tarballs and the plan are written to. It is emptied first. */
  readonly out: string;
  /** The number the candidates are packed under. */
  readonly candidate: number;
}

export async function packRelease(
  workspace: Workspace,
  options: PackOptions,
  registry: Registry,
): Promise<Plan> {
  const { root } = workspace;
  const record = await readRecord(root);
  const pkgs = dependencyOrder(await buildWorkspace(workspace));
  const statuses = await statusesOf(workspace, pkgs, record);
  for (const name of record.keys()) {
    if (!statuses.has(name)) {
      throw new Error(
        `${RECORD_FILE} releases ${name}, which nothing here builds.`,
      );
    }
  }
  // What the registry holds of each package a release recorded, or that a build can name.
  const finalOnly = new Set(
    pkgs.filter((pkg) => pkg.source.finalAt === "merge").map(nameOf),
  );
  const published = new Map(
    await Promise.all(
      [...new Set([...record.keys(), ...finalOnly])].map(
        async (name): Promise<[string, Set<string>]> => [
          name,
          new Set(await registry.versions(name)),
        ],
      ),
    ),
  );

  const declared = await declaredVersions(workspace);
  const repository = await repositoryOf(root);
  await rm(options.out, { recursive: true, force: true });
  for (const stage of ["merge", "production"]) {
    await mkdir(path.join(options.out, stage), { recursive: true });
  }
  const plan = {
    merge: [] as Packed[],
    production: [] as Packed[],
    withheld: [] as Withheld[],
  };
  const pack = async (
    stage: Stage,
    tag: Packed["tag"],
    pkg: Publishable,
    version: string,
  ) => {
    const file = path.join(stage, tarballName(nameOf(pkg), version));
    const manifest = publishedManifest(pkg.built, {
      version,
      workspace: declared,
      repository,
      directory: pkg.directory,
    });
    await packPackage(pkg.builtDir, manifest, path.join(options.out, file));
    plan[stage].push({ name: nameOf(pkg), version, file, tag });
  };
  // A package names each package whose final goes out at merge at the version its build does.
  // That version must be published, or published first by this run. Before that package's first
  // release, once its version is set ahead of a release, or once its release is passed over, it is
  // neither, and what names it waits for its next release.
  const unpublished = (pkg: Publishable) =>
    dependenciesOf(pkg, finalOnly)
      .map((dep) => statuses.get(dep)!.pkg.built)
      .find(
        (dep) =>
          !published.get(dep.name)!.has(dep.version) &&
          !plan.merge.some(
            (p) => p.name === dep.name && p.version === dep.version,
          ),
      );

  for (const pkg of pkgs) {
    const name = nameOf(pkg);
    const release = record.get(name);
    if (release === undefined) continue;
    const { version } = release;
    const versions = published.get(name)!;
    if (versions.has(version)) continue;
    // A release is checked as it merges, so main building it differently means later changes
    // replaced it. It is passed over, and the next release takes the next version.
    if (!buildsAsRecorded(statuses.get(name)!)) {
      plan.withheld.push({
        name,
        version,
        reason:
          "main has changed it since its release, so a later release replaces it",
      });
      continue;
    }
    const dep = unpublished(pkg);
    if (dep !== undefined) {
      plan.withheld.push({
        name,
        version,
        reason: `its build names ${dep.name} ${dep.version}, which is not published`,
      });
      continue;
    }
    if (pkg.source.finalAt === "merge") {
      await pack("merge", "latest", pkg, version);
      continue;
    }
    const candidates = [...versions].filter((v) =>
      v.startsWith(`${version}-rc.`),
    );
    if (candidates.length === 0) {
      await pack(
        "merge",
        "rc",
        pkg,
        candidateVersion(version, options.candidate),
      );
    }
    await pack("production", "latest", pkg, version);
  }
  await writeFile(
    path.join(options.out, PLAN_FILE),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  return plan;
}

export interface Registry {
  /** Every version of the package published, or none when the package is not there. */
  versions(name: string): Promise<string[]>;
  publish(file: string, tag: string): Promise<void>;
}

const execFile = promisify(execFileCb);

// What `pnpm view <name> versions --json` says of a package: its versions, one as a string and
// more as a list, or an error whose code says the package is not there. Any other error, such as
// a refused token, is not an answer.
const NOT_PUBLISHED = new Set([
  "ERR_PNPM_PACKAGE_NOT_FOUND",
  "ERR_PNPM_FETCH_404",
]);

export function versionsFrom(output: string, name: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (isRecord(parsed) && isRecord(parsed.error)) {
    const { code } = parsed.error;
    if (typeof code === "string" && NOT_PUBLISHED.has(code)) return [];
    throw new Error(
      `The registry gave no answer for ${name}: ${output.trim()}`,
    );
  }
  const versions = [parsed].flat();
  if (!versions.every((v) => typeof v === "string")) {
    throw new Error(
      `The registry gave no versions for ${name}: ${output.trim()}`,
    );
  }
  return versions;
}

// The registry through pnpm, from the workspace root, whose .npmrc names it for the scope.
export function pnpmRegistry(root: string): Registry {
  return {
    async versions(name) {
      const args = ["view", name, "versions", "--json"];
      const output = await execFile("pnpm", args, { cwd: root }).then(
        ({ stdout }) => stdout,
        (error: unknown) => {
          const { stdout } = isRecord(error) ? error : {};
          if (typeof stdout !== "string" || stdout.trim() === "") throw error;
          return stdout;
        },
      );
      return versionsFrom(output, name);
    },
    async publish(file, tag) {
      const args = ["publish", file, "--tag", tag, "--no-git-checks"];
      await execFile("pnpm", args, { cwd: root });
    },
  };
}

// Each package goes out under the tag the plan gives it, in the plan's order, so a dependency is
// published before what names it. A version already published is passed over, so a stage that
// failed part of the way through can run again.
export async function publishRelease(
  dir: string,
  stage: Stage,
  registry: Registry,
): Promise<{ published: string[]; skipped: string[] }> {
  const plan = JSON.parse(
    await readFile(path.join(dir, PLAN_FILE), "utf-8"),
  ) as unknown;
  const packed = isRecord(plan) ? plan[stage] : undefined;
  if (!Array.isArray(packed)) {
    throw new Error(`${PLAN_FILE} lists no ${stage}.`);
  }
  const published: string[] = [];
  const skipped: string[] = [];
  for (const entry of packed as Packed[]) {
    const spec = `${entry.name}@${entry.version}`;
    if ((await registry.versions(entry.name)).includes(entry.version)) {
      skipped.push(spec);
      continue;
    }
    await registry.publish(path.join(dir, entry.file), entry.tag);
    published.push(spec);
  }
  return { published, skipped };
}
