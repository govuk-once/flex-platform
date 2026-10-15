import {
  Edge,
  OriginRequestFunction,
  ViewerRequestFunction,
} from "@repo/frontdoor-infra";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { EnvironmentConfig } from "../config/types.ts";

/** Where CloudFront takes a web ACL from. */
export const FRONTDOOR_REGION = "us-east-1";

// The environment's main stack, so the one name with no thing (see frontdoor/infra's names.ts).
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
      env: { account: environment.frontdoor.account, region: FRONTDOOR_REGION },
      // Deleting it takes the app's entry point and its name with it, so it takes a deliberate
      // step first, whatever asks.
      terminationProtection: true,
    });

    const viewerRequest = new ViewerRequestFunction(this, "ViewerRequest", {
      environment: environment.name,
      issuers: environment.frontdoor.issuers,
    });

    const originRequest = new OriginRequestFunction(this, "OriginRequest", {
      environment: environment.name,
      issuers: environment.frontdoor.issuers,
      // Built from config once FLEX-497 adds domains to it. Until then every verified request is
      // a 404.
      routes: {},
      apiAccounts: environment.domainAccounts.map(({ account }) => account),
    });

    const edge = new Edge(this, "Edge", {
      environment: environment.name,
      zone: {
        zoneName: environment.frontdoor.zone.name,
        hostedZoneId: environment.frontdoor.zone.id,
      },
      viewerRequestFunction: viewerRequest.function,
      originRequestFunction: originRequest.version,
    });

    // The one value nothing can derive: CloudFront names the distribution.
    new CfnOutput(this, "DistributionDomainName", {
      value: edge.distribution.distributionDomainName,
    });
  }
}
