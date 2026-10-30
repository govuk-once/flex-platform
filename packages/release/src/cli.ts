import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { type Planned, prepare, releaseAll } from "./prepare.ts";
import { terminalChooser } from "./prompt.ts";
import {
  packRelease,
  pnpmRegistry,
  publishRelease,
  type Stage,
} from "./publish.ts";
import { candidateNumber, RECORD_FILE, recordAt } from "./record.ts";
import { SOURCES } from "./sources.ts";
import { verifyRelease } from "./verify.ts";

// The command, run from the workspace root:
//
//   release [--all]                                prepare a release, by a person
//   release verify --base <commit>                 on a pull request, against its base
//   release pack --out <dir>                       in the pipeline, on main
//   release publish <dir> --stage merge|production  in the pipeline, on main
//
// Exported and free of process handling, so it is exercised as a function; the bin script is the
// exit code and nothing else.

const execFile = promisify(execFileCb);

export function pullRequestBody(planned: readonly Planned[]): string {
  const rows = planned.map(
    ({ name, from, to, reason }) =>
      `| \`${name}\` | ${from ?? "none"} | ${to} | ${reason} |`,
  );
  return ["| Package | From | To | Why |", "|---|---|---|---|", ...rows].join(
    "\n",
  );
}

async function prepareCommand(root: string, args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    options: { all: { type: "boolean", default: false } },
  });
  const { stdout } = await execFile("git", ["status", "--porcelain"], {
    cwd: root,
  });
  if (stdout.trim() !== "") {
    throw new Error(
      "The working tree has changes. A release records what is committed, so commit or stash them first.",
    );
  }
  const planned = await prepare(
    { root, sources: SOURCES },
    values.all ? releaseAll : terminalChooser,
  );
  if (planned.length === 0) return "Nothing to release.";
  return [
    `Wrote ${RECORD_FILE}. Commit it with any manifest the release changed, and open a pull request:`,
    "",
    pullRequestBody(planned),
  ].join("\n");
}

async function verifyCommand(root: string, args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    options: { base: { type: "string" } },
  });
  if (values.base === undefined) {
    throw new Error("release verify needs --base <commit>.");
  }
  const released = await verifyRelease(
    { root, sources: SOURCES },
    await recordAt(root, values.base),
  );
  return released.length === 0
    ? "Releases nothing."
    : released.map((name) => `releases ${name}, as recorded`).join("\n");
}

async function packCommand(root: string, args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    options: { out: { type: "string" } },
  });
  if (values.out === undefined) {
    throw new Error("release pack needs --out <dir>.");
  }
  const plan = await packRelease(
    { root, sources: SOURCES },
    {
      out: path.resolve(root, values.out),
      candidate: await candidateNumber(root),
    },
    pnpmRegistry(root),
  );
  const lines = [
    ...(["merge", "production"] as const).flatMap((stage) =>
      plan[stage].map(
        ({ name, version, tag }) => `${stage}: ${name}@${version} (${tag})`,
      ),
    ),
    ...plan.withheld.map(
      ({ name, version, reason }) =>
        `withheld: ${name}@${version}, as ${reason}`,
    ),
  ];
  return lines.length === 0 ? "Nothing to publish." : lines.join("\n");
}

async function publishCommand(root: string, args: string[]): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { stage: { type: "string" } },
  });
  const stage = values.stage;
  if (
    positionals.length !== 1 ||
    (stage !== "merge" && stage !== "production")
  ) {
    throw new Error(
      "release publish needs <dir> and --stage merge|production.",
    );
  }
  const { published, skipped } = await publishRelease(
    path.resolve(root, positionals[0]!),
    stage satisfies Stage,
    pnpmRegistry(root),
  );
  return [
    ...published.map((spec) => `published ${spec}`),
    ...skipped.map((spec) => `already published ${spec}`),
  ].join("\n");
}

export async function main(
  root: string,
  argv: readonly string[],
): Promise<string> {
  if (!existsSync(path.join(root, "pnpm-workspace.yaml"))) {
    throw new Error("Run release from the workspace root.");
  }
  const [command, ...rest] = argv;
  if (command === "verify") return verifyCommand(root, rest);
  if (command === "pack") return packCommand(root, rest);
  if (command === "publish") return publishCommand(root, rest);
  return prepareCommand(root, [...argv]);
}
