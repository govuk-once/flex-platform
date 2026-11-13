import {
  CI_ORIGIN_HOST_PARAMETER,
  MANAGEMENT_REGION,
  ManagementEdge,
  ManagementViewerRequestFunction,
} from "@repo/shared-infra";
import { CfnOutput, Stack } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

import type { SharedConfig } from "../config/types.ts";

// One per stage, in the stage's own shared account, so the name holds no stage.
export const SHARED_MANAGEMENT_STACK_NAME = "shared-management";

/**
 * The distribution a stage is managed through, at the apex of the shared account's zone, in the
 * region CloudFront takes a web ACL and a certificate from. It reads the host of the pipeline
 * API's function URL from the parameter the release stack writes in this region. Nothing it
 * creates is exposed: another stack that reached in would take a dependency on this one.
 */
export class SharedManagementStack extends Stack {
  constructor(scope: Construct, shared: SharedConfig) {
    super(scope, SHARED_MANAGEMENT_STACK_NAME, {
      description: "Flex management distribution, in front of the pipeline API",
      env: { account: shared.account, region: MANAGEMENT_REGION },
      // Deleting it takes the pipeline API's address with it, so it takes a deliberate step
      // first, whatever asks.
      terminationProtection: true,
    });

    const viewerRequest = new ManagementViewerRequestFunction(
      this,
      "ViewerRequest",
      { zoneName: shared.zone.name },
    );

    const edge = new ManagementEdge(this, "Edge", {
      zone: { zoneName: shared.zone.name, hostedZoneId: shared.zone.id },
      viewerRequestFunction: viewerRequest.function,
      ciOriginHost: StringParameter.valueForStringParameter(
        this,
        CI_ORIGIN_HOST_PARAMETER,
      ),
    });

    // The one value nothing can derive: CloudFront names the distribution.
    new CfnOutput(this, "DistributionDomainName", {
      value: edge.distribution.distributionDomainName,
    });
  }
}
