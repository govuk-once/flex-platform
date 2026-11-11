import { describe, expect, it } from "vitest";

import {
  checkStage,
  DEPLOYMENTS_READ,
  type EnvironmentDeployment,
  type StageCheck,
} from "./stage-check.ts";

// main's history, oldest first: each commit includes those before it.
const HISTORY = ["a", "b", "c"];

function includes(commit: string, ancestor: string): boolean {
  return HISTORY.indexOf(ancestor) <= HISTORY.indexOf(commit);
}

/**
 * GitHub's record of each stage's environment, newest first. A job adds its deployment, in
 * progress, before its first step, so the check sees it. The job then succeeds or fails, and a
 * success marks the stage's earlier ones inactive.
 */
class Environments {
  readonly #deployments = new Map<string, { sha: string; state: string }[]>();

  async deploy(stage: string, commit: string): Promise<StageCheck> {
    const deployments = this.#deployments.get(stage) ?? [];
    this.#deployments.set(stage, deployments);
    const own = { sha: commit, state: "in_progress" };
    deployments.unshift(own);

    const check = await checkStage(commit, [...deployments], includes);
    if (check.outcome === "older" || check.outcome === "unknown") {
      own.state = "failure";
    } else {
      for (const earlier of deployments) {
        if (earlier.state === "success") earlier.state = "inactive";
      }
      own.state = "success";
    }
    return check;
  }

  fail(stage: string, commit: string): void {
    this.#deployments.get(stage)?.unshift({ sha: commit, state: "failure" });
  }
}

describe("checkStage", () => {
  it("deploys a commit to a stage after a newer one has gone to another", async () => {
    const github = new Environments();

    await expect(github.deploy("platform-dev", "a")).resolves.toEqual({
      outcome: "first",
    });
    await expect(github.deploy("platform-dev", "b")).resolves.toEqual({
      outcome: "includes",
      deployed: "a",
    });
    await expect(github.deploy("platform-staging", "a")).resolves.toEqual({
      outcome: "first",
    });
    await expect(github.deploy("platform-staging", "b")).resolves.toEqual({
      outcome: "includes",
      deployed: "a",
    });
  });

  it("refuses a commit older than the stage has, after the newer one deployed", async () => {
    const github = new Environments();
    await github.deploy("platform-dev", "a");
    await github.deploy("platform-dev", "b");
    await github.deploy("platform-staging", "b");

    await expect(github.deploy("platform-staging", "a")).resolves.toEqual({
      outcome: "older",
      deployed: "b",
    });
    // A retry of the older commit's dev jobs too.
    await expect(github.deploy("platform-dev", "a")).resolves.toEqual({
      outcome: "older",
      deployed: "b",
    });
    // And refusing it changed nothing: the stage still has the newer one.
    await expect(github.deploy("platform-staging", "a")).resolves.toEqual({
      outcome: "older",
      deployed: "b",
    });
  });

  it("deploys the commit the stage has again, as a retry or a later wave", async () => {
    const github = new Environments();
    await github.deploy("platform-dev", "b");

    await expect(github.deploy("platform-dev", "b")).resolves.toEqual({
      outcome: "includes",
      deployed: "b",
    });
  });

  it("counts a commit once any of its jobs succeeds, even if a later wave fails", async () => {
    const github = new Environments();
    await github.deploy("platform-dev", "a");
    await github.deploy("platform-dev", "b");
    github.fail("platform-dev", "b");

    await expect(github.deploy("platform-dev", "a")).resolves.toEqual({
      outcome: "older",
      deployed: "b",
    });
    await expect(github.deploy("platform-dev", "c")).resolves.toEqual({
      outcome: "includes",
      deployed: "b",
    });
  });

  it("passes over deployments that failed, are running or are inactive", async () => {
    const deployments: EnvironmentDeployment[] = [
      { sha: "c", state: "in_progress" },
      { sha: "c", state: "failure" },
      { sha: "b", state: "success" },
      { sha: "a", state: "inactive" },
    ];

    await expect(checkStage("c", deployments, includes)).resolves.toEqual({
      outcome: "includes",
      deployed: "b",
    });
  });

  it("reads no further than the newest deployment that succeeded", async () => {
    let read = 0;
    function* deployments(): Generator<EnvironmentDeployment> {
      for (const deployment of [
        { sha: "b", state: "failure" },
        { sha: "b", state: "success" },
        { sha: "a", state: "success" },
      ]) {
        read += 1;
        yield deployment;
      }
    }

    await checkStage("c", deployments(), includes);

    expect(read).toBe(2);
  });

  it("can't tell what the stage has when none of the newest deployments succeeded", async () => {
    const failed = (count: number): EnvironmentDeployment[] =>
      Array.from({ length: count }, () => ({ sha: "c", state: "failure" }));

    await expect(
      checkStage("c", failed(DEPLOYMENTS_READ), includes),
    ).resolves.toEqual({ outcome: "unknown" });
    await expect(
      checkStage("c", failed(DEPLOYMENTS_READ - 1), includes),
    ).resolves.toEqual({ outcome: "first" });
  });
});
