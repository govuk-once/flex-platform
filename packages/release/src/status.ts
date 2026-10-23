import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { publishedManifest } from "./manifest.ts";
import { contentDigest } from "./package.ts";
import { RECORD_FILE, type Release, type ReleaseRecord } from "./record.ts";
import {
  bumped,
  compareVersions,
  nextDerivedVersion,
  parseVersion,
  suggestedBump,
} from "./versions.ts";
import {
  declaredVersions,
  nameOf,
  type Publishable,
  repositoryOf,
  type Workspace,
} from "./workspace.ts";

// Each package as built, set against its last release in the record, and the version its next
// release takes.

export interface Status {
  readonly pkg: Publishable;
  readonly released: Release | undefined;
  readonly digest: string;
  /** Why the package has changes no release holds yet, or undefined when it has none. */
  readonly reason: string | undefined;
}

function reasonFor(
  pkg: Publishable,
  released: Release | undefined,
  digest: string,
): string | undefined {
  if (released === undefined) return "not released yet";
  if (pkg.source.versioning === "derived") {
    const next = parseVersion(
      nextDerivedVersion(pkg.built.version, released.version),
    );
    if (next.major > parseVersion(released.version).major) return "new major";
    if (next.patch === 0) return "new schema";
  } else if (compareVersions(pkg.built.version, released.version) > 0) {
    return `version set to ${pkg.built.version}`;
  }
  return released.digest === digest ? undefined : "contents changed";
}

// Whether a package builds as its record entry releases it: the same contents, at a version its
// build can be released as. A derived package's build writes its major and minor, and the release
// its patch.
export function buildsAsRecorded({ pkg, released, digest }: Status): boolean {
  if (released === undefined || released.digest !== digest) return false;
  if (pkg.source.versioning === "declared") {
    return pkg.built.version === released.version;
  }
  const [built, recorded] = [
    parseVersion(pkg.built.version),
    parseVersion(released.version),
  ];
  return built.major === recorded.major && built.minor === recorded.minor;
}

export async function statusesOf(
  workspace: Workspace,
  pkgs: readonly Publishable[],
  record: ReleaseRecord,
): Promise<Map<string, Status>> {
  const repository = await repositoryOf(workspace.root);
  const versions = await declaredVersions(workspace);
  const statuses = await Promise.all(
    pkgs.map(async (pkg): Promise<Status> => {
      const manifest = publishedManifest(pkg.built, {
        version: pkg.built.version,
        workspace: versions,
        repository,
        directory: pkg.directory,
      });
      const digest = await contentDigest(pkg.builtDir, manifest);
      const released = record.get(nameOf(pkg));
      const reason = reasonFor(pkg, released, digest);
      return { pkg, released, digest, reason };
    }),
  );
  return new Map(statuses.map((status) => [nameOf(status.pkg), status]));
}

/** The titles of the commits that changed a package since it was last released. */
export type History = (root: string, pkg: Publishable) => Promise<string[]>;

const execFile = promisify(execFileCb);

// The last commit that changed a package's line in the record is its last release, so the
// commits since then that touched its directory are its changes.
export const gitHistory: History = async (root, pkg) => {
  const git = async (...args: string[]) =>
    (await execFile("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }))
      .stdout;
  const line = `${JSON.stringify(nameOf(pkg)).replaceAll(".", "\\.")}:`;
  const last = (
    await git("log", "-1", "--format=%H", `-G${line}`, "--", RECORD_FILE)
  ).trim();
  const range = last === "" ? [] : [`${last}..HEAD`];
  const titles = await git("log", "--format=%s", ...range, "--", pkg.directory);
  return titles.split("\n").filter((title) => title !== "");
};

// The version a package's next release takes. A derived package's is its build's major and
// minor, at the next patch. A declared package's is its manifest's, when a person has set it
// ahead of the last release, such as for a major; otherwise the last release, raised by the
// titles of the changes since.
export async function nextVersion(
  root: string,
  status: Status,
  history: History,
): Promise<string> {
  const { pkg, released } = status;
  const built = pkg.built.version;
  if (pkg.source.versioning === "derived") {
    return nextDerivedVersion(built, released?.version);
  }
  if (released === undefined) return built;
  const order = compareVersions(built, released.version);
  if (order > 0) return built;
  if (order < 0) {
    throw new Error(
      `${pkg.directory}/package.json holds ${built}, behind ${released.version}, its last release.`,
    );
  }
  return bumped(released.version, suggestedBump(await history(root, pkg)));
}
