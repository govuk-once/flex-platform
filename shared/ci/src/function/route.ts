import type { ReleaseTarget } from "./authorise.ts";

/** The only method the API takes, as the CloudFront Function in front of it holds requests to. */
export const ALLOWED_METHODS: readonly string[] = ["POST"];

// One segment each for the environment and the domain. Nothing is decoded: the CloudFront
// Function lets only a plain path through, and a name that isn't in the config is refused later.
const UPLOADS = /^\/ci\/environments\/([^/]+)\/domains\/([^/]+)\/uploads$/;

/** The environment and domain an upload is for, if the path is the uploads route. */
export function uploadTarget(path: string): ReleaseTarget | undefined {
  const match = UPLOADS.exec(path);
  const environment = match?.[1];
  const domain = match?.[2];
  if (environment === undefined || domain === undefined) return undefined;
  return { environment, domain };
}
