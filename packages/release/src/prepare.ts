import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readRecord, writeRecord } from "./record.ts";
import {
  gitHistory,
  type History,
  nextVersion,
  type Status,
  statusesOf,
} from "./status.ts";
import {
  buildWorkspace,
  dependencyOrder,
  lockedIn,
  nameOf,
  type Workspace,
} from "./workspace.ts";

// Prepares a release: builds every package, lists those with changes no release holds yet, has a
// person choose which to release, and writes their next versions into the record and each
// declared package's manifest. A pull request of that is the release, and the pipeline publishes
// it once merged.

export interface Choice extends Status {
  /** The version its release would take. */
  readonly next: string;
}

/** What releasing the chosen packages brings with it, and why. */
export type Lock = (chosen: ReadonlySet<string>) => ReadonlyMap<string, string>;

// The decision a release leaves to a person: which packages to release. The command asks it at a
// prompt, which shows what each choice brings with it as it is made; `--all` and the tests
// answer it without one. Only packages with unreleased changes can be chosen, and the rest of the
// tree comes with them whatever the answer.
export interface Chooser {
  select(choices: readonly Choice[], lock: Lock): Promise<ReadonlySet<string>>;
}

export interface Planned {
  readonly name: string;
  readonly from: string | undefined;
  readonly to: string;
  readonly reason: string;
}

async function setVersion(file: string, version: string): Promise<string> {
  const text = await readFile(file, "utf-8");
  const manifest = JSON.parse(text) as Record<string, unknown>;
  manifest.version = version;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return text;
}

export async function prepare(
  workspace: Workspace,
  chooser: Chooser,
  history: History = gitHistory,
): Promise<Planned[]> {
  const { root } = workspace;
  const record = new Map(await readRecord(root));
  let pkgs = await buildWorkspace(workspace);
  let statuses = await statusesOf(workspace, pkgs, record);
  const pending = new Set(
    [...statuses.values()]
      .filter((s) => s.reason !== undefined)
      .map((s) => nameOf(s.pkg)),
  );
  if (pending.size === 0) return [];
  const choices = await Promise.all(
    [...statuses.values()].map(async (s) => ({
      ...s,
      next: await nextVersion(root, s, history),
    })),
  );
  const answer = await chooser.select(choices, (chosen) =>
    lockedIn(pkgs, chosen, pending),
  );
  const chosen = new Set([...answer].filter((name) => pending.has(name)));
  if (chosen.size === 0) return [];
  const locked = lockedIn(pkgs, chosen, pending);
  const releasing = dependencyOrder(
    pkgs.filter((pkg) => chosen.has(nameOf(pkg)) || locked.has(nameOf(pkg))),
  );
  const reasons = new Map(
    releasing.map((pkg) => [
      nameOf(pkg),
      statuses.get(nameOf(pkg))!.reason ?? locked.get(nameOf(pkg))!,
    ]),
  );

  // Each manifest as it was, to put back if the release goes no further.
  const originals = new Map<string, string>();
  try {
    for (const pkg of releasing) {
      if (pkg.source.versioning !== "declared") continue;
      const version = await nextVersion(
        root,
        statuses.get(nameOf(pkg))!,
        history,
      );
      if (version === pkg.built.version) continue;
      const file = path.join(root, pkg.directory, "package.json");
      originals.set(file, await setVersion(file, version));
    }
    // A new version changes what names it, so the digests are taken from a new build.
    if (originals.size > 0) {
      pkgs = await buildWorkspace(workspace);
      statuses = await statusesOf(workspace, pkgs, record);
    }

    const planned: Planned[] = [];
    for (const { built } of releasing) {
      const status = statuses.get(built.name)!;
      const version = await nextVersion(root, status, history);
      record.set(built.name, { version, digest: status.digest });
      planned.push({
        name: built.name,
        from: status.released?.version,
        to: version,
        reason: reasons.get(built.name)!,
      });
    }
    await writeRecord(root, record);
    return planned;
  } catch (error) {
    for (const [file, text] of originals) await writeFile(file, text);
    throw error;
  }
}

// Answers the way `--all` does: everything with unreleased changes, and what they bring with them.
export const releaseAll: Chooser = {
  select: (choices) =>
    Promise.resolve(
      new Set(
        choices.filter((c) => c.reason !== undefined).map((c) => nameOf(c.pkg)),
      ),
    ),
};
