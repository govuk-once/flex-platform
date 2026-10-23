import {
  readRecord,
  RECORD_FILE,
  releasedBetween,
  type ReleaseRecord,
} from "./record.ts";
import { buildsAsRecorded, statusesOf } from "./status.ts";
import { buildWorkspace, type Workspace } from "./workspace.ts";

// What a pull request runs, on the commit its merge would make. A release that changes the record
// must build as it records each package, so main only builds a recorded version differently once
// later changes replace it. That is what lets the pipeline pass such a version over instead of
// refusing it. The record is also held to only moving forward.

export async function verifyRelease(
  workspace: Workspace,
  before: ReleaseRecord,
): Promise<string[]> {
  const record = await readRecord(workspace.root);
  const released = releasedBetween(before, record);
  if (released.length === 0) return [];
  const pkgs = await buildWorkspace(workspace);
  const statuses = await statusesOf(workspace, pkgs, record);
  const problems = released.flatMap((name) => {
    const status = statuses.get(name);
    if (status === undefined) {
      return [`${RECORD_FILE} releases ${name}, which nothing here builds.`];
    }
    if (buildsAsRecorded(status)) return [];
    return [
      `${name} does not build as ${RECORD_FILE} releases it, at ${record.get(name)!.version}. Prepare the release again.`,
    ];
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return released;
}
