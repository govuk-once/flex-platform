import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import {
  FrontdoorCallerTokenKeysStack,
  frontdoorCallerTokenKeysStackName,
} from "./frontdoor-keys.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;

describe("FrontdoorCallerTokenKeysStack", () => {
  it("is one per environment, in the frontdoor account in eu-west-2, protected from deletion", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      const stack = assembly.getStackByName(
        frontdoorCallerTokenKeysStackName(environment),
      );
      expect(stack.environment).toMatchObject({
        account: environment.frontdoor.account,
        region: "eu-west-2",
      });
      expect(stack.terminationProtection).toBe(true);
    }
  });

  it("lets every gateway's role in every domain account read the public keys, by its name's pattern", () => {
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), DEV),
    );
    const roles = DEV.domainAccounts
      .map(
        ({ account }) =>
          `arn:aws:iam::${account}:role/gateway-${DEV.name}-*-execution`,
      )
      .sort();
    expect(roles.length).toBeGreaterThan(0);

    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: `frontdoor-${DEV.name}-keys-${DEV.frontdoor.account}`,
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:GetObject",
            Condition: {
              ArnLike: {
                "aws:PrincipalArn": roles,
              },
            },
          }),
        ]),
      },
    });
  });

  it("leaves out a domain account that runs no gateway", () => {
    const [first] = DEV.domainAccounts;
    const idle = { ...first, account: "100000000099", gateways: [] };
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), {
        ...DEV,
        domainAccounts: [...DEV.domainAccounts, idle],
      }),
    );
    expect(JSON.stringify(template.toJSON())).not.toContain("100000000099");
  });

  it("has key rotation write the public keys to the environment's bucket, and no other account's of the same name", () => {
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), DEV),
    );
    template.hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject"],
                Resource: `arn:aws:s3:::frontdoor-${DEV.name}-keys-${DEV.frontdoor.account}/caller-token-keys.json`,
                Condition: {
                  StringEquals: {
                    "aws:ResourceAccount": DEV.frontdoor.account,
                  },
                },
              },
            ]),
          },
        },
      ],
    });
  });
});
