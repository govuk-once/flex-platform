import { Duration } from "aws-cdk-lib";
import { PriceClass, SecurityPolicyProtocol } from "aws-cdk-lib/aws-cloudfront";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

import type { Stage } from "./environment.ts";

export const PLATFORM_REGION = "eu-west-2";

export const CLOUDFRONT_GLOBAL_REGION = "us-east-1";

export const EDGE_MINIMUM_TLS = SecurityPolicyProtocol.TLS_V1_2_2021;

export const EDGE_PRICE_CLASS = PriceClass.PRICE_CLASS_100;

export const EDGE_RATE_LIMIT_PER_FIVE_MINUTES = 2000;

export const EDGE_RATE_LIMIT_RESPONSE_CODE = 429;

export const EDGE_ACCESS_LOG_RETENTION = Duration.days(90);

export const EDGE_WAF_LOG_RETENTION = RetentionDays.THREE_MONTHS;

export const EDGE_CONTENT_SECURITY_POLICY = "default-src 'self'";

export const EDGE_ORIGIN_PATH = "/prod";

export const PLATFORM_TAGS: Readonly<Record<string, string>> = {
  Product: "GOV.UK",
  System: "FLEX",
  Owner: "N/A",
  ResourceOwner: "flex-platform",
  Source: "https://github.com/govuk-once/flex-platform",
};

export const PARAMETERS = {
  hostedZoneId: "/infra/dns/hostedzoneid",
  hostedZoneName: "/infra/dns/hostedzonename",
  originDomainName: (stage: Stage) =>
    `/${stage.name}/flex/edge/origin/domain-name`,
} as const;

/** Written for the stacks that follow the edge. */
export const EDGE_EXPORTS = {
  distributionId: (stage: Stage) => `/${stage.name}/flex/edge/distribution-id`,
  distributionDomainName: (stage: Stage) =>
    `/${stage.name}/flex/edge/distribution-domain-name`,
  url: (stage: Stage) => `/${stage.name}/flex/edge/url`,
} as const;

export function edgeDomainName(stage: Stage, zoneName: string): string {
  return stage.persistent ? zoneName : `${stage.name}.${zoneName}`;
}

export function edgeStackName(stage: Stage): string {
  return `${stage.name}-FlexEdge`;
}

export function edgeGlobalStackName(stage: Stage): string {
  return `${stage.name}-FlexEdgeGlobal`;
}
