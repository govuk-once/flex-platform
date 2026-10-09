import { Edge, ViewerRequestFunction } from "@repo/frontdoor-infra";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { EnvironmentConfig } from "../config/types.ts";

/** Where CloudFront takes a web ACL from. */
export const FRONTDOOR_REGION = "us-east-1";

export function frontdoorStackName(environment: EnvironmentConfig): string {
  return `frontdoor-${environment.name}`;
}

/**
 * One environment's edge, in its frontdoor account. Nothing it creates is exposed: another stack
 * that reached in would take a dependency on this one.
 */
export class FrontdoorStack extends Stack {
  constructor(scope: Construct, environment: EnvironmentConfig) {
    super(scope, frontdoorStackName(environment), {
      description: `Flex front door for the ${environment.name} environment`,
      env: { account: environment.frontdoorAccount, region: FRONTDOOR_REGION },
    });

    const viewerRequest = new ViewerRequestFunction(this, "ViewerRequest", {
      issuers: environment.frontdoor.issuers,
    });

    const edge = new Edge(this, "Edge", {
      environment: environment.name,
      domainName: environment.domainName,
      viewerRequestFunction: viewerRequest.function,
    });

    // The one value nothing can derive: CloudFront names the distribution.
    new CfnOutput(this, "DistributionDomainName", {
      value: edge.distribution.distributionDomainName,
    });
  }
}
