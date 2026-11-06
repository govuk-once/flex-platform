import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import {
  FrontdoorCallerTokenKeysStack,
  frontdoorCallerTokenKeysStackName,
  FrontdoorKeyRotationStack,
  frontdoorKeyRotationStackName,
  frontdoorSigningKeyStackName,
} from "./frontdoor-keys.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;

describe("FrontdoorSigningKeyStack", () => {
  it("is one per environment, in the frontdoor account in the signing region, protected from deletion", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      const stack = assembly.getStackByName(
        frontdoorSigningKeyStackName(environment),
      );
      expect(stack.environment).toMatchObject({
        account: environment.frontdoor.account,
        region: "eu-west-2",
      });
      expect(stack.terminationProtection).toBe(true);
    }
  });
});

describe("FrontdoorCallerTokenKeysStack", () => {
  it("is one per environment, in the frontdoor account in the gateways' region, protected from deletion", () => {
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

  it("lets every gateway's role in every domain account read the public keys", () => {
    const template = Template.fromStack(
      new FrontdoorCallerTokenKeysStack(cdkApp(), DEV),
    );
    const roles = DEV.domainAccounts
      .flatMap(({ account, gateways }) =>
        gateways.map(
          ({ id }) =>
            `arn:aws:iam::${account}:role/gateway-${DEV.name}-${id}-execution`,
        ),
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
              ArnEquals: {
                "aws:PrincipalArn": roles,
              },
            },
          }),
        ]),
      },
    });
  });
});

describe("FrontdoorKeyRotationStack", () => {
  it("is one per environment, in the signing region, deployed after the signing key and the public keys' bucket", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      const stack = assembly.getStackByName(
        frontdoorKeyRotationStackName(environment),
      );
      expect(stack.environment).toMatchObject({
        account: environment.frontdoor.account,
        region: "eu-west-2",
      });
      const dependencies = stack.dependencies
        .map(({ id }) => id)
        .filter((id) => !id.endsWith(".assets"))
        .sort();
      expect(dependencies).toEqual([
        frontdoorCallerTokenKeysStackName(environment),
        frontdoorSigningKeyStackName(environment),
      ]);
    }
  });

  it("writes the public keys to the environment's bucket, and no other account's of the same name", () => {
    const template = Template.fromStack(
      new FrontdoorKeyRotationStack(cdkApp(), DEV),
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
