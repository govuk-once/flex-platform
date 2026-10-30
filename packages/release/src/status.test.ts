import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setFile } from "../test/fixture.ts";
import { RECORD_FILE, serializeRecord } from "./record.ts";
import { SOURCES } from "./sources.ts";
import { gitHistory } from "./status.ts";

describe("gitHistory", () => {
  const execFile = promisify(execFileCb);
  let root: string;
  // The person's own git configuration stays out, so a commit is never signed with their key or
  // run through their hooks.
  const git = async (...args: string[]) =>
    execFile("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  const commit = async (title: string) => {
    await git("add", "-A");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      title,
    );
  };
  const client = {
    source: SOURCES[0]!,
    directory: "client",
    builtDir: "client/dist",
    built: { name: "@govuk-once/a", version: "0.1.0" },
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "release-git-"));
    await git("init", "-q");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds the titles of a package's changes since its line of the record last changed", async () => {
    await setFile(root, "client/src.js", "1");
    await commit("FLEX-1 feat: Before any release");
    expect(await gitHistory(root, client)).toEqual([
      "FLEX-1 feat: Before any release",
    ]);

    await setFile(
      root,
      RECORD_FILE,
      serializeRecord(
        new Map([
          [
            "@govuk-once/a",
            { version: "0.1.0", digest: `sha256:${"a".repeat(64)}` },
          ],
        ]),
      ),
    );
    await commit("FLEX-2 chore: Release");
    await setFile(root, "client/src.js", "2");
    await commit("FLEX-3 fix: In the client");
    await setFile(root, "elsewhere.js", "2");
    await commit("FLEX-4 feat: Elsewhere");

    expect(await gitHistory(root, client)).toEqual([
      "FLEX-3 fix: In the client",
    ]);
  });
});
