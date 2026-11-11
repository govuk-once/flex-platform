/**
 * One deployment GitHub records for a job in a stage's environment: the commit its run deploys,
 * and its latest status, such as `success`, `failure`, `in_progress` or `inactive`.
 */
export interface EnvironmentDeployment {
  readonly sha: string;
  readonly state: string;
}

/** How many of an environment's newest deployments the check reads, at most. */
export const DEPLOYMENTS_READ = 100;

export type StageCheck =
  /** The stage has never deployed. */
  | { readonly outcome: "first" }
  /** The stage has `deployed`, which the commit includes, so deploying it goes forward. */
  | { readonly outcome: "includes"; readonly deployed: string }
  /** The stage has `deployed`, which the commit doesn't include, so deploying it would go back. */
  | { readonly outcome: "older"; readonly deployed: string }
  /** None of the newest deployments succeeded, so what the stage has is further back. */
  | { readonly outcome: "unknown" };

/**
 * Whether a commit may deploy to a stage: only if it includes the commit the stage has, which is
 * the newest deployment that succeeded. Every account job is a deployment of its own, so a commit
 * counts once any one of its jobs succeeds, even if a later wave fails: some of the stage's stacks
 * run it. Deployments come newest first, and are read only as far as the newest that succeeded.
 */
export async function checkStage(
  commit: string,
  deployments:
    AsyncIterable<EnvironmentDeployment> | Iterable<EnvironmentDeployment>,
  /** Whether `commit` includes `ancestor`, as `git merge-base --is-ancestor` answers it. */
  includes: (commit: string, ancestor: string) => boolean | Promise<boolean>,
): Promise<StageCheck> {
  let read = 0;
  for await (const deployment of deployments) {
    read += 1;
    if (deployment.state !== "success") continue;
    const deployed = deployment.sha;
    return (await includes(commit, deployed))
      ? { outcome: "includes", deployed }
      : { outcome: "older", deployed };
  }
  return read >= DEPLOYMENTS_READ
    ? { outcome: "unknown" }
    : { outcome: "first" };
}
