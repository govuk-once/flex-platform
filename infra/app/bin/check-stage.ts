// Refuses a deploy that would take a stage back: `tsx bin/check-stage.ts <stage>`, in the deploy
// workflow, with GH_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA set and the repository's full history
// checked out. Exits non-zero, with a GitHub error annotation, unless the run's commit includes
// the commit the stage has.

import { spawnSync } from "node:child_process";

import {
  checkStage,
  DEPLOYMENTS_READ,
  type EnvironmentDeployment,
} from "../src/stage-check.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is not set`);
  return value;
}

const [stage] = process.argv.slice(2);
if (stage === undefined) throw new Error("Usage: check-stage.ts <stage>");
const token = required("GH_TOKEN");
const repository = required("GITHUB_REPOSITORY");
const commit = required("GITHUB_SHA");

async function github(path: string): Promise<unknown[]> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub answered ${String(response.status)} for ${path}`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error(`GitHub's ${path} is not a list`);
  return body as unknown[];
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

// Newest first, and each one's statuses only until the newest that succeeded.
async function* deployments(): AsyncGenerator<EnvironmentDeployment> {
  const listed = await github(
    `deployments?environment=${encodeURIComponent(stage ?? "")}&per_page=${String(DEPLOYMENTS_READ)}`,
  );
  for (const deployment of listed) {
    const id = field(deployment, "id");
    const sha = field(deployment, "sha");
    if (typeof id !== "number" || typeof sha !== "string") {
      throw new TypeError("GitHub listed a deployment without an id and a sha");
    }
    const path = `deployments/${String(id)}/statuses?per_page=1`;
    const [latest] = await github(path); // NOSONAR: one at a time, to stop at the newest success
    const state = field(latest, "state");
    yield { sha, state: typeof state === "string" ? state : "" };
  }
}

// `git merge-base --is-ancestor` exits 0 when it does, 1 when it doesn't, and anything else when
// it can't tell, such as for a commit it doesn't have.
function includes(descendant: string, ancestor: string): boolean {
  const { status } = spawnSync(
    "git", // NOSONAR: the runner's PATH, which every step of the job runs with
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { stdio: "inherit" },
  );
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Error(`git can't tell whether ${descendant} includes ${ancestor}`);
}

const check = await checkStage(commit, deployments(), includes);
switch (check.outcome) {
  case "first":
    console.log(`${stage} has never deployed.`);
    break;
  case "includes":
    console.log(`${stage} has ${check.deployed}, which ${commit} includes.`);
    break;
  case "older":
    console.log(
      `::error::${stage} has ${check.deployed}, which ${commit} doesn't include. A deploy never goes back: deploy a newer commit.`,
    );
    process.exitCode = 1;
    break;
  case "unknown":
    console.log(
      `::error::None of ${stage}'s ${String(DEPLOYMENTS_READ)} newest deployments succeeded, so what it has is unknown.`,
    );
    process.exitCode = 1;
    break;
}
