import { PlatformCloudFrontFunction } from "@repo/infra-constructs";
import { buildViewerRequestFunction } from "@repo/shared-viewer-request";
import type { Construct } from "constructs";

import {
  ciAudience,
  MANAGEMENT_VIEWER_REQUEST_FUNCTION_NAME,
  PIPELINE_TOKEN_ISSUER,
} from "./names.ts";

export interface ManagementViewerRequestFunctionProps {
  /** The shared account's zone, whose apex the pipeline API answers at. */
  readonly zoneName: string;
}

/**
 * The CloudFront Function that checks each request to the management distribution, built with
 * the issuer and the audience a pipeline's token must name, and the log group it writes to.
 */
export class ManagementViewerRequestFunction extends PlatformCloudFrontFunction {
  constructor(
    scope: Construct,
    id: string,
    props: ManagementViewerRequestFunctionProps,
  ) {
    super(scope, id, {
      functionName: MANAGEMENT_VIEWER_REQUEST_FUNCTION_NAME,
      code: buildViewerRequestFunction({
        issuer: PIPELINE_TOKEN_ISSUER,
        audience: ciAudience(props.zoneName),
      }),
    });
  }
}
