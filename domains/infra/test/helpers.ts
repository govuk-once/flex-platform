import { readFileSync } from "node:fs";

import { App, Stack } from "aws-cdk-lib";
import type { Template } from "aws-cdk-lib/assertions";

import type { DomainProps } from "../src/domain.ts";
import type { DomainNetwork, NetworkPlacement } from "../src/network.ts";

const CDK_JSON_CONTEXT = (
  JSON.parse(
    readFileSync(
      new URL("../../../infra/app/cdk.json", import.meta.url),
      "utf8",
    ),
  ) as { context: Record<string, unknown> }
).context;

export const DOMAIN_ACCOUNT = "100000000003";
export const FRONTDOOR_ACCOUNT = "100000000002";
export const REGION = "eu-west-2";
export const ENVIRONMENT = "development";
export const ZONE_NAME = "development.flex-domain00.example";
export const HOSTED_ZONE_ID = "Z100000000003";
export const HOST_NAME = `domain-one.${ZONE_NAME}`;
export const FRONTDOOR_ROLE_ARN = `arn:aws:iam::${FRONTDOOR_ACCOUNT}:role/frontdoor-${ENVIRONMENT}-edge`;
export const ISOLATED_SUBNET_IDS = [
  "subnet-0000000000000000a",
  "subnet-0000000000000000b",
];
export const PRIVATE_SUBNET_IDS = [
  "subnet-0000000000000000c",
  "subnet-0000000000000000d",
];
export const ISOLATED_SECURITY_GROUP_ID = "sg-00000000000000001";
export const PRIVATE_SECURITY_GROUP_ID = "sg-00000000000000002";

export const ISOLATED_PLACEMENT: NetworkPlacement = {
  subnetIds: ISOLATED_SUBNET_IDS,
  securityGroupId: ISOLATED_SECURITY_GROUP_ID,
};

export const PRIVATE_PLACEMENT: NetworkPlacement = {
  subnetIds: PRIVATE_SUBNET_IDS,
  securityGroupId: PRIVATE_SECURITY_GROUP_ID,
};

export const NETWORK: DomainNetwork = {
  isolated: ISOLATED_PLACEMENT,
  private: PRIVATE_PLACEMENT,
};

export const SHARED_RESOURCES: Omit<DomainProps, "config"> = {
  environment: ENVIRONMENT,
  hostName: HOST_NAME,
  frontdoorRoleArn: FRONTDOOR_ROLE_ARN,
  network: NETWORK,
};

export interface TestStack {
  readonly app: App;
  readonly stack: Stack;
}

export function createTestStack(): TestStack {
  const app = new App({ context: CDK_JSON_CONTEXT });

  const stack = new Stack(app, "domain", {
    env: { account: DOMAIN_ACCOUNT, region: REGION },
  });

  return { app, stack };
}

interface TemplateJson {
  readonly Resources: Readonly<Record<string, { readonly Type: string }>>;
}

export function countResourcesByType(
  template: Template,
): Record<string, number> {
  const { Resources } = template.toJSON() as TemplateJson;
  const counts: Record<string, number> = {};

  for (const { Type } of Object.values(Resources)) {
    counts[Type] = (counts[Type] ?? 0) + 1;
  }

  return counts;
}
