// What the CloudFront Functions runtime calls. Only the build bundles this module: it replaces
// VIEWER_REQUEST_CONFIG with an environment's config, so the function needs nothing at runtime.
import type { ViewerRequestConfig, ViewerRequestEvent } from "./types.ts";
import { viewerRequest } from "./viewer-request.ts";

declare const VIEWER_REQUEST_CONFIG: ViewerRequestConfig;

// The runtime needs a function declaration named handler, not an arrow function.
export function handler(event: ViewerRequestEvent) {
  return viewerRequest(event, VIEWER_REQUEST_CONFIG, Date.now() / 1000);
}
