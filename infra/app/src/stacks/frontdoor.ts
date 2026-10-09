import { Edge } from "@repo/frontdoor-infra";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { EnvironmentConfig } from "../config/types.ts";

/** Where CloudFront takes a web ACL from. */
export const FRONTDOOR_REGION = "us-east-1";

export function frontdoorStackName(environment: EnvironmentConfig): string {
  return `frontdoor-${environment.name}`;
}

/** One environment's edge, in its frontdoor account. */
export class FrontdoorStack extends Stack {
  public readonly edge: Edge;

  constructor(scope: Construct, environment: EnvironmentConfig) {
    super(scope, frontdoorStackName(environment), {
      description: `Flex front door for the ${environment.name} environment`,
      env: { account: environment.frontdoorAccount, region: FRONTDOOR_REGION },
    });

    this.edge = new Edge(this, "Edge", {
      environment: environment.name,
      domainName: environment.domainName,
      issuers: environment.frontdoor.issuers,
      rateLimitPerFiveMinutes: environment.frontdoor.rateLimitPerFiveMinutes,
      logRetention: environment.frontdoor.logRetentionDays,
    });

    // The one value nothing can derive: CloudFront names the distribution.
    new CfnOutput(this, "DistributionDomainName", {
      value: this.edge.distribution.distributionDomainName,
    });
  }
}
