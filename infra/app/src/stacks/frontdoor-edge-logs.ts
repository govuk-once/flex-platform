import { OriginRequestLogs } from "@repo/frontdoor-infra";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { EnvironmentConfig } from "../config/types.ts";

// Named as frontdoor/infra's names.ts describes, with the region last: collecting logs in another
// region is another stack beside this one. Renaming this one later would collide with the group it
// retains.
export function frontdoorEdgeLogsStackName(
  environment: EnvironmentConfig,
  region: string,
): string {
  return `frontdoor-${environment.name}-edge-logs-${region}`;
}

/**
 * The Lambda@Edge function's log group in one region. The function is in us-east-1 and names the
 * group, which Lambda@Edge writes to in whichever region a copy runs; its role can write only
 * where one of these stacks has created it, through the policy the stack provides.
 */
export class FrontdoorEdgeLogsStack extends Stack {
  constructor(
    scope: Construct,
    environment: EnvironmentConfig,
    region: string,
  ) {
    super(scope, frontdoorEdgeLogsStackName(environment, region), {
      description: `Flex front door's Lambda@Edge logs in ${region} for the ${environment.name} environment`,
      env: { account: environment.frontdoor.account, region },
      // Without its log group, Lambda@Edge's logs go nowhere.
      terminationProtection: true,
    });

    new OriginRequestLogs(this, "OriginRequestLogs", {
      environment: environment.name,
    });
  }
}
