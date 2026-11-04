import { execFile as execFileCb } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isRecord } from "@repo/utils/is-record";
import { sortedEntries } from "@repo/utils/sorted-entries";

import { compareVersions, parseVersion } from "./versions.ts";

// The record: each published package's last released version, and the digest of what was
// released under it. A release pull request changes it, and a merge publishes the entries it
// changed. It is written one package to a line, so each release's diff is a line per package.

export const RECORD_FILE = "packages/release/releases.json";

export interface Release {
  readonly version: string;
  readonly digest: string;
}

export type ReleaseRecord = ReadonlyMap<string, Release>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function parseRecord(text: string): ReleaseRecord {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${RECORD_FILE} is not an object.`);
  return new Map(
    sortedEntries(parsed).map(([name, release]): [string, Release] => {
      if (
        !isRecord(release) ||
        Object.keys(release).length !== 2 ||
        typeof release.version !== "string" ||
        typeof release.digest !== "string" ||
        !DIGEST.test(release.digest)
      ) {
        throw new Error(
          `${RECORD_FILE} holds ${JSON.stringify(name)} as something other than its version and digest.`,
        );
      }
      parseVersion(release.version);
      return [name, { version: release.version, digest: release.digest }];
    }),
  );
}

export function serializeRecord(record: ReleaseRecord): string {
  const lines = sortedEntries(Object.fromEntries(record)).map(
    ([name, { version, digest }]) =>
      `  ${JSON.stringify(name)}: { "version": ${JSON.stringify(version)}, "digest": ${JSON.stringify(digest)} }`,
  );
  return lines.length === 0 ? "{}\n" : `{\n${lines.join(",\n")}\n}\n`;
}

export async function readRecord(root: string): Promise<ReleaseRecord> {
  return parseRecord(await readFile(path.join(root, RECORD_FILE), "utf-8"));
}

export async function writeRecord(
  root: string,
  record: ReleaseRecord,
): Promise<void> {
  await writeFile(path.join(root, RECORD_FILE), serializeRecord(record));
}

const execFile = promisify(execFileCb);

// The record as a commit holds it. A commit from before the record existed released nothing.
export async function recordAt(
  root: string,
  revision: string,
): Promise<ReleaseRecord> {
  const run = (...args: string[]) =>
    execFile("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const { stdout: commit } = await run(
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  );
  const file = `${commit.trim()}:${RECORD_FILE}`;
  try {
    await run("cat-file", "-e", file);
  } catch {
    return new Map();
  }
  return parseRecord((await run("show", file)).stdout);
}

// A candidate's number: how many commits HEAD has. Each commit on main holds the one before it,
// so the number only grows as main does, and is the same each time a commit is packed again. A
// shallow clone holds too few commits to count.
export async function candidateNumber(root: string): Promise<number> {
  const git = async (...args: string[]) =>
    (await execFile("git", args, { cwd: root })).stdout.trim();
  if ((await git("rev-parse", "--is-shallow-repository")) === "true") {
    throw new Error(
      "The clone is shallow, so its commits cannot be counted. Fetch the whole history.",
    );
  }
  return Number(await git("rev-list", "--count", "HEAD"));
}

// The packages a commit releases: those whose recorded version differs from the one before it.
// A version only moves forward, and what it released never changes, since one that was published
// can never be published again. A digest changed under the same version would count changes no
// release published as released.
export function releasedBetween(
  before: ReleaseRecord,
  after: ReleaseRecord,
): string[] {
  for (const [name, { version, digest }] of before) {
    const now = after.get(name);
    if (now === undefined) {
      throw new Error(`${RECORD_FILE} no longer holds ${name}.`);
    }
    if (compareVersions(now.version, version) < 0) {
      throw new Error(
        `${RECORD_FILE} moves ${name} back from ${version} to ${now.version}.`,
      );
    }
    if (now.version === version && now.digest !== digest) {
      throw new Error(
        `${RECORD_FILE} changes what ${name} ${version} released. Release a new version instead.`,
      );
    }
  }
  return [...after]
    .filter(([name, { version }]) => before.get(name)?.version !== version)
    .map(([name]) => name);
}
