import type { RouteDefinition } from "../router.ts";
import { release } from "./release.ts";
import { status } from "./status.ts";
import { upload } from "./upload.ts";

/**
 * Every route the API answers. Each path names an environment and a domain, which the pipeline
 * must be allowed for before the route's handler runs.
 */
export const ROUTES: readonly RouteDefinition[] = [
  {
    method: "POST",
    path: "/ci/environments/{environment}/domains/{domain}/uploads",
    handle: upload,
  },
  {
    method: "POST",
    path: "/ci/environments/{environment}/domains/{domain}/releases",
    handle: release,
  },
  {
    method: "GET",
    path: "/ci/environments/{environment}/domains/{domain}/releases/{releaseId}",
    handle: status,
  },
];
