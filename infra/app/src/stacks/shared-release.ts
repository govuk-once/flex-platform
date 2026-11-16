import { CrossRegionParameters } from "@repo/infra-constructs";
import {
  CI_ORIGIN_HOST_PARAMETER,
  CiFunction,
  CROSS_REGION_WRITER_LOG_GROUP_NAME,
  MANAGEMENT_REGION,
  SHARED_REGION,
} from "@repo/shared-infra";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { SharedConfig } from "../config/types.ts";

// One per stage, in the stage's own shared account, so the name holds no stage.
export const SHARED_RELEASE_STACK_NAME = "shared-release";

/**
 * The stage's pipeline API: its function and the URL CloudFront reaches it at. AWS generates the
 * URL's host here, and the distribution is in us-east-1, so the stack writes the host to a
 * parameter there for the distribution's stack to read.
 */
export class SharedReleaseStack extends Stack {
  constructor(scope: Construct, shared: SharedConfig) {
    super(scope, SHARED_RELEASE_STACK_NAME, {
      description:
        "Flex pipeline API, which a domain's pipeline releases through",
      env: { account: shared.account, region: SHARED_REGION },
      terminationProtection: true,
    });

    const ci = new CiFunction(this, "Ci");

    new CrossRegionParameters(this, "CrossRegion", {
      logGroupName: CROSS_REGION_WRITER_LOG_GROUP_NAME,
      parameters: {
        [MANAGEMENT_REGION]: { [CI_ORIGIN_HOST_PARAMETER]: ci.urlHost },
      },
    });
  }
}
