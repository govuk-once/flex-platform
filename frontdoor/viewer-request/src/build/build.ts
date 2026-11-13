import { buildCloudFrontFunction } from "@repo/cloudfront-function/build";

import type { ViewerRequestConfig } from "../function/types.ts";

const ENTRY = new URL("../function/entry.ts", import.meta.url).pathname;

// Synchronous, because CDK builds constructs synchronously.
export function buildViewerRequestFunction(
  config: ViewerRequestConfig,
): string {
  return buildCloudFrontFunction({
    entry: ENTRY,
    define: { VIEWER_REQUEST_CONFIG: config },
  });
}
