import { readFileSync } from "node:fs";

import { App, Stack } from "aws-cdk-lib";

import type { DomainProps } from "../src/domain.ts";
import type { DomainNetwork } from "../src/network.ts";

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
export const EXECUTION_ROLE_ARN = `arn:aws:iam::${DOMAIN_ACCOUNT}:role/domain-execution`;
export const FRONTDOOR_ROLE_ARN = `arn:aws:iam::${FRONTDOOR_ACCOUNT}:role/frontdoor`;
export const ISOLATED_SUBNET_IDS = ["subnet-isolateda", "subnet-isolatedb"];
export const PRIVATE_SUBNET_IDS = ["subnet-privatea", "subnet-privateb"];
export const ISOLATED_SECURITY_GROUP_ID = "sg-00000000000000001";
export const PRIVATE_SECURITY_GROUP_ID = "sg-00000000000000002";

const EC2_ARN_PREFIX = `arn:aws:ec2:${REGION}:${DOMAIN_ACCOUNT}`;

export const NETWORK: DomainNetwork = {
  vpcArn: `${EC2_ARN_PREFIX}:vpc/vpc-00000000000000001`,
  availabilityZones: ["eu-west-2a", "eu-west-2b"],
  isolated: {
    subnetArns: ISOLATED_SUBNET_IDS.map(
      (id) => `${EC2_ARN_PREFIX}:subnet/${id}`,
    ),
    securityGroupArn: `${EC2_ARN_PREFIX}:security-group/${ISOLATED_SECURITY_GROUP_ID}`,
  },
  private: {
    subnetArns: PRIVATE_SUBNET_IDS.map(
      (id) => `${EC2_ARN_PREFIX}:subnet/${id}`,
    ),
    securityGroupArn: `${EC2_ARN_PREFIX}:security-group/${PRIVATE_SECURITY_GROUP_ID}`,
  },
};

export const SHARED_RESOURCES: Omit<DomainProps, "config"> = {
  executionRoleArn: EXECUTION_ROLE_ARN,
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
