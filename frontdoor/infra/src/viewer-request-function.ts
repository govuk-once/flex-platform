import type { TrustedIssuer } from "@repo/frontdoor-shared";
import { buildViewerRequestFunction } from "@repo/frontdoor-viewer-request";
import { PlatformCloudFrontFunction } from "@repo/infra-constructs";
import type { Construct } from "constructs";

import { viewerRequestFunctionName } from "./names.ts";

export interface ViewerRequestFunctionProps {
  readonly environment: string;
  /** The user pools and app clients whose tokens the function lets through. */
  readonly issuers: readonly TrustedIssuer[];
}

/**
 * The CloudFront Function that checks each request's structure, built with an environment's
 * issuers, and the log group it writes to.
 */
export class ViewerRequestFunction extends PlatformCloudFrontFunction {
  constructor(scope: Construct, id: string, props: ViewerRequestFunctionProps) {
    super(scope, id, {
      functionName: viewerRequestFunctionName(props.environment),
      code: buildViewerRequestFunction({ issuers: props.issuers }),
    });
  }
}
