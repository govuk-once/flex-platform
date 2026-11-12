import { SHARED_REGION, TestUserPool } from "@repo/shared-infra";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { SharedConfig } from "../config/types.ts";

// One per stage, in the stage's own shared account, so the name holds no stage.
export const SHARED_IDENTITY_STACK_NAME = "shared-identity";

/**
 * The stage's test users. It depends on nothing, and nothing depends on it at deploy: an
 * environment's Frontdoor trusts the pool only once config names its generated IDs. It outputs
 * those IDs for a person to copy into config, and exports nothing, since an export would let
 * another stack depend on it.
 */
export class SharedIdentityStack extends Stack {
  constructor(scope: Construct, shared: SharedConfig) {
    super(scope, SHARED_IDENTITY_STACK_NAME, {
      description:
        "Flex test users, for the environments whose Frontdoor trusts them",
      env: { account: shared.account, region: SHARED_REGION },
      terminationProtection: true,
    });

    const testUsers = new TestUserPool(this, "TestUsers");

    new CfnOutput(this, "TestUsersIssuer", {
      description: "The issuer shared.testUsers takes",
      value: testUsers.userPool.userPoolProviderUrl,
    });
    new CfnOutput(this, "TestUsersClientId", {
      description: "The client ID shared.testUsers takes",
      value: testUsers.client.userPoolClientId,
    });
  }
}
