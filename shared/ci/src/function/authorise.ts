// Decides what a verified pipeline may release: only the domain its repository is registered
// for, and only in the environment its job runs in.

import type { Pipeline } from "./token.ts";
import type { CiConfig } from "./types.ts";

/** What a request is for, as its path names it. Both names are the caller's until allowed. */
export interface ReleaseTarget {
  readonly environment: string;
  readonly domain: string;
}

// Why a pipeline was refused, as a fixed code for the log. The caller is told none of them: it
// gets the same answer for each, so it learns nothing of which environments and domains exist.
export type Refusal =
  | "environment-unknown"
  | "domain-not-hosted"
  | "domain-unregistered"
  | "repository"
  | "owner"
  | "environment-claim";

export type Authorise = (
  pipeline: Pipeline,
  target: ReleaseTarget,
) => Refusal | undefined;

export function createAuthoriser(
  config: Pick<CiConfig, "environments" | "domains">,
): Authorise {
  // Maps and sets, because the names looked up come from the caller, and an object lookup finds
  // inherited members.
  const hosted = new Map(
    config.environments.map(({ name, domains }) => [name, new Set(domains)]),
  );
  const registered = new Map(
    config.domains.map((domain) => [domain.name, domain]),
  );

  return (pipeline, target) => {
    const domains = hosted.get(target.environment);
    if (domains === undefined) return "environment-unknown";
    if (!domains.has(target.domain)) return "domain-not-hosted";
    const domain = registered.get(target.domain);
    if (domain === undefined) return "domain-unregistered";

    // Both IDs: a repository transferred to another owner is no longer the one registered.
    if (pipeline.repositoryId !== domain.repositoryId) return "repository";
    if (pipeline.ownerId !== domain.ownerId) return "owner";

    // GitHub sets the claim only for a job that runs in that environment, with its protection
    // rules passed. So a job can act only on the environment its repository let it into.
    if (pipeline.environment !== target.environment) return "environment-claim";
    return undefined;
  };
}

export type Publishes = (environment: string) => boolean;

/**
 * Whether new code enters an environment from a pipeline, by an upload and then a release.
 * Elsewhere code arrives only by promotion, so a pipeline's code there would be code that skipped
 * the environments before it.
 */
export function createPublishCheck(
  config: Pick<CiConfig, "environments">,
): Publishes {
  const publishing = new Set(
    config.environments
      .filter(({ publishes }) => publishes)
      .map(({ name }) => name),
  );
  return (environment) => publishing.has(environment);
}
