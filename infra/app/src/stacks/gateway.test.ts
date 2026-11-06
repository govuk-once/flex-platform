import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  FIXTURE_STAGES,
  GATEWAYS,
  synthesizedStage,
} from "../../test/helpers.ts";
import type { GatewayConfig } from "../config/types.ts";
import { gatewayBundle } from "../gateway-bundle.ts";
import { GatewayStack, gatewayStackName } from "./gateway.ts";
import { networkStackName } from "./network.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;
const [MAIN] = DEV.domainAccounts;
const UDP = GATEWAYS[0]!;

function build(gateway: GatewayConfig = UDP) {
  const stack = new GatewayStack(cdkApp(), {
    environment: DEV,
    domainAccount: MAIN,
    gateway,
    bundle: gatewayBundle("udp"),
  });
  return { stack, template: Template.fromStack(stack) };
}

// The value of the SSM parameter a CloudFormation parameter reads, by the parameter's name.
function ssmParameter(template: Template, name: string): string {
  const parameters = template.toJSON().Parameters as Record<
    string,
    { Default?: string }
  >;
  const found = Object.entries(parameters).find(
    ([, { Default }]) => Default === name,
  );
  if (found === undefined) throw new Error(`No parameter reads ${name}`);
  return found[0];
}

describe("GatewayStack", () => {
  it("is one per gateway in each domain account, in its account and eu-west-2, deployed after its network", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      for (const domainAccount of environment.domainAccounts) {
        for (const gateway of domainAccount.gateways) {
          const stack = assembly.getStackByName(
            gatewayStackName(environment, domainAccount, gateway),
          );
          expect(stack.environment).toMatchObject({
            account: domainAccount.account,
            region: "eu-west-2",
          });
          expect(stack.dependencies.map(({ id }) => id)).toContain(
            networkStackName(environment, domainAccount),
          );
        }
      }
    }
  });

  it("names its function as the client invokes it, and the stack after the account it's in", () => {
    const { stack, template } = build();
    expect(stack.stackName).toBe("gateway-dev-main-udp");
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "gateway-dev-udp",
    });
    template.hasResourceProperties("AWS::Lambda::Alias", { Name: "live" });
  });

  it("runs in its placement's subnets and security group", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::Lambda::Function", {
      VpcConfig: {
        SubnetIds: {
          Ref: ssmParameter(template, "/flex/network/dev/private-subnet-ids"),
        },
        SecurityGroupIds: [
          {
            Ref: ssmParameter(
              template,
              "/flex/network/dev/security-group/private-gateway",
            ),
          },
        ],
      },
    });

    const isolated = build({ ...UDP, placement: "isolated" }).template;
    isolated.hasResourceProperties("AWS::Lambda::Function", {
      VpcConfig: {
        SubnetIds: {
          Ref: ssmParameter(isolated, "/flex/network/dev/isolated-subnet-ids"),
        },
        SecurityGroupIds: [
          {
            Ref: ssmParameter(
              isolated,
              "/flex/network/dev/security-group/isolated-gateway",
            ),
          },
        ],
      },
    });
  });

  it("reads an upstream's secret, with its key, and assumes the upstream's role, only through the endpoints", () => {
    const { template } = build();
    if (UDP.secret === "create")
      throw new Error("UDP's secret is its upstream's");

    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: { FLEX_UPSTREAM_SECRET_ARN: UDP.secret.arn },
      },
    });
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "gateway-dev-udp-execution",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: "secretsmanager:GetSecretValue",
                Resource: UDP.secret.arn,
              },
              {
                Effect: "Deny",
                Action: ["secretsmanager:GetSecretValue", "sts:AssumeRole"],
                Resource: "*",
                Condition: {
                  StringNotEquals: {
                    "aws:SourceVpce": [
                      {
                        Ref: ssmParameter(
                          template,
                          "/flex/network/dev/endpoint/secretsmanager",
                        ),
                      },
                      {
                        Ref: ssmParameter(
                          template,
                          "/flex/network/dev/endpoint/sts",
                        ),
                      },
                    ],
                  },
                },
              },
              Match.objectLike({
                Action: "kms:Decrypt",
                Resource: UDP.secret.keyArn,
              }),
              {
                Effect: "Allow",
                Action: "sts:AssumeRole",
                Resource: UDP.roleArns[0],
              },
            ]),
          },
        },
      ],
    });
  });

  it("creates a secret of its own, which its role alone may read, when config says to", () => {
    const { template } = build({
      ...UDP,
      secret: "create",
      roleArns: [],
      target: "https://api.udp.example",
    });

    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "gateway-dev-udp",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          FLEX_UPSTREAM_SECRET_ARN: { Ref: Match.stringLikeRegexp("^Secret") },
          FLEX_UPSTREAM_TARGET: "https://api.udp.example",
        },
      },
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: "secretsmanager:GetSecretValue",
                Resource: `arn:aws:secretsmanager:eu-west-2:${MAIN.account}:secret:gateway-dev-udp-??????`,
              },
            ]),
          },
        },
      ],
    });
    template.hasResourceProperties("AWS::SecretsManager::ResourcePolicy", {
      ResourcePolicy: {
        Statement: [
          Match.objectLike({
            Effect: "Deny",
            Condition: {
              StringNotEquals: {
                "aws:PrincipalArn": `arn:aws:iam::${MAIN.account}:role/gateway-dev-udp-execution`,
              },
            },
          }),
        ],
      },
    });
  });

  it("sets no target where the driver takes it from the secret", () => {
    const { template } = build();
    const [fn] = Object.values(
      template.findResources("AWS::Lambda::Function"),
    ) as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    }[];
    expect(Object.keys(fn?.Properties.Environment.Variables ?? {})).toEqual([
      "FLEX_UPSTREAM_SECRET_ARN",
    ]);
  });
});
