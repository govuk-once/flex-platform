import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { heldValue } from "@repo/utils/held-value";

import { readRecord, writeRecord } from "./record.ts";
import type { Status } from "./status.ts";
import { nextVersion, statusesOf } from "./status.ts";
import type { Bump } from "./versions.ts";
import { bumped, nextDerivedVersion } from "./versions.ts";
import type { Publishable, Workspace } from "./workspace.ts";
import {
  buildWorkspace,
  dependencyOrder,
  lockedIn,
  nameOf,
} from "./workspace.ts";

// Prepares a release: builds every package, lists those with changes no release holds yet, has a
// person choose which to release, and writes their next versions into the record and each
// declared package's manifest. A pull request of that is the release, and the pipeline publishes
// it once merged.

export interface Choice extends Status {
  /** The version its release would take, or undefined when a person chooses the bump. */
  readonly next: string | undefined;
}

/** What releasing the chosen packages brings with it, and why. */
export type Lock = (chosen: ReadonlySet<string>) => ReadonlyMap<string, string>;

// The decisions a release leaves to a person: which packages to release, and how each declared
// package's last release is raised when its manifest does not say. The command asks them at a
// prompt, which shows what each choice brings with it as it is made; `--all` and the tests
// answer them without one. Only packages with unreleased changes can be chosen, and the rest of
// the tree comes with them whatever the answer.
export interface Chooser {
  select(choices: readonly Choice[], lock: Lock): Promise<ReadonlySet<string>>;
  /** How a declared package is raised from `from`, its last release. */
  bump(choice: Choice, from: string): Promise<Bump>;
}

export interface Planned {
  readonly name: string;
  readonly from: string | undefined;
  readonly to: string;
  readonly reason: string;
}

// Each declared package's last release raised by the bump a person chooses, asked for before
// anything is written.
async function getRaisedVersions(
  releasing: readonly Publishable[],
  choices: ReadonlyMap<string, Choice>,
  chooser: Chooser,
): Promise<Map<string, string>> {
  const raised = new Map<string, string>();

  for (const pkg of releasing) {
    if (pkg.source.versioning !== "declared") continue;

    const choice = heldValue(choices, nameOf(pkg));

    const { released, next } = choice;

    // Its first release, or one a person set ahead: the manifest holds it already.
    if (released === undefined || next !== undefined) continue;

    const bump = await chooser.bump(choice, released.version);
    raised.set(nameOf(pkg), bumped(released.version, bump));
  }

  return raised;
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
  const choices = new Map(
    [...statuses].map(([name, s]) => [name, { ...s, next: nextVersion(s) }]),
  );
  const answer = await chooser.select([...choices.values()], (chosen) =>
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
      heldValue(statuses, nameOf(pkg)).reason ?? heldValue(locked, nameOf(pkg)),
    ]),
  );
  const raisedVersions = await getRaisedVersions(releasing, choices, chooser);

  // Each manifest as it was, to put back if the release goes no further.
  const originals = new Map<string, string>();

  try {
    for (const pkg of releasing) {
      const version = raisedVersions.get(nameOf(pkg));

      if (version === undefined) continue;

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
      const { pkg, released, digest } = heldValue(statuses, built.name);
      // Built again, a declared package's manifest holds its new version.
      const version =
        pkg.source.versioning === "declared"
          ? pkg.built.version
          : nextDerivedVersion(pkg.built.version, released?.version);
      record.set(built.name, { version, digest });
      planned.push({
        name: built.name,
        from: released?.version,
        to: version,
        reason: heldValue(reasons, built.name),
      });
    }
    await writeRecord(root, record);
    return planned;
  } catch (error) {
    for (const [file, text] of originals) await writeFile(file, text);
    throw error;
  }
}

// Answers the way `--all` does: everything with unreleased changes, and what they bring with them,
// each declared package raised by a patch.
export const releaseAll: Chooser = {
  select: (choices) =>
    Promise.resolve(
      new Set(
        choices.filter((c) => c.reason !== undefined).map((c) => nameOf(c.pkg)),
      ),
    ),
  bump: () => Promise.resolve("patch"),
};
