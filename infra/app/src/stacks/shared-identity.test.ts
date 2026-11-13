import { cdkApp } from "@repo/infra-constructs";
import { SHARED_REGION } from "@repo/shared-infra";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { inventory } from "../inventory.ts";
import {
  SHARED_IDENTITY_STACK_NAME,
  SharedIdentityStack,
} from "./shared-identity.ts";

const [, , PROD] = FIXTURE_STAGES;

const stackNames = (stage: (typeof FIXTURE_STAGES)[number]) =>
  synthesizedStage(stage).stacks.map((stack) => stack.stackName);

describe("SharedIdentityStack", () => {
  // Every stage has the pool, so the stacks are the same in each. Only issuers differ.
  it.each(FIXTURE_STAGES)("is built in $name", (stage) => {
    expect(stackNames(stage)).toContain(SHARED_IDENTITY_STACK_NAME);
  });

  it("is in the stage's shared account, in its region, protected from deletion", () => {
    const stack = new SharedIdentityStack(cdkApp(), PROD.shared);

    expect(stack.stackName).toBe("shared-identity");
    expect(stack.account).toBe(PROD.shared.account);
    expect(stack.region).toBe(SHARED_REGION);
    expect(stack.terminationProtection).toBe(true);
  });

  // Nothing waits on it at deploy, so it can never hold up an environment's first deploy.
  it("depends on no stack, and no stack depends on it", () => {
    const stacks = inventory(synthesizedStage(PROD));

    for (const stack of stacks) {
      if (stack.name === SHARED_IDENTITY_STACK_NAME) {
        expect(stack.dependencies).toEqual([]);
      } else {
        expect(stack.dependencies).not.toContain(SHARED_IDENTITY_STACK_NAME);
      }
    }
  });

  it("holds the test user pool, and reads nothing", () => {
    const template = Template.fromStack(
      new SharedIdentityStack(cdkApp(), PROD.shared),
    );
    template.resourceCountIs("AWS::Cognito::UserPool", 1);

    const { Parameters } = template.toJSON() as {
      Parameters: Record<string, unknown>;
    };
    expect(Object.keys(Parameters)).toEqual(["BootstrapVersion"]);
  });

  // A person copies these into shared.testUsers. An export would let a stack depend on this one.
  it("outputs the pool's issuer and client ID, and exports nothing", () => {
    const template = Template.fromStack(
      new SharedIdentityStack(cdkApp(), PROD.shared),
    );
    const [pool] = Object.keys(
      template.findResources("AWS::Cognito::UserPool"),
    );
    const [client] = Object.keys(
      template.findResources("AWS::Cognito::UserPoolClient"),
    );

    expect(template.toJSON().Outputs).toEqual({
      TestUsersIssuer: {
        Description: "The issuer shared.testUsers takes",
        Value: { "Fn::GetAtt": [pool, "ProviderURL"] },
      },
      TestUsersClientId: {
        Description: "The client ID shared.testUsers takes",
        Value: { Ref: client },
      },
    });
  });
});
