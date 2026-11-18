import type { RouteDefinition } from "../router.ts";
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
];
