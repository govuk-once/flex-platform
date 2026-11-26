import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT,
  buildNetwork,
  KEYS_OBJECT,
  KEYS_TABLE,
  UPSTREAM_ACCOUNT,
  UPSTREAM_API,
  UPSTREAM_ROLE,
  UPSTREAM_SECRET,
  ZonedStack,
} from "../../test/network.ts";
import { cdkApp } from "../cdk-app.ts";
import {
  InterfaceEndpoints,
  type PrivateApiAccess,
} from "./interface-endpoints.ts";
import { NatAddresses } from "./nat-addresses.ts";
import { NetworkVpc } from "./vpc.ts";

const GATEWAY_ROLES = `arn:aws:iam::${ACCOUNT}:role/gateway-sandbox-*-execution`;

function endpoint(
  service: string,
  Action: string,
  Resource: unknown,
  resourceAccount?: string,
  principals?: string,
  privateDns = true,
) {
  return {
    ServiceName: `com.amazonaws.eu-west-2.${service}`,
    VpcEndpointType: "Interface",
    PrivateDnsEnabled: privateDns,
    SubnetIds: [
      { Ref: Match.stringLikeRegexp("^NetworkIsolatedeuwest2aSubnet") },
      { Ref: Match.stringLikeRegexp("^NetworkIsolatedeuwest2bSubnet") },
    ],
    PolicyDocument: {
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action,
          Resource,
          Condition: {
            StringEquals: {
              "aws:PrincipalAccount": ACCOUNT,
              ...(resourceAccount !== undefined && {
                "aws:ResourceAccount": [resourceAccount],
              }),
            },
            ...(principals !== undefined && {
              ArnLike: { "aws:PrincipalArn": principals },
            }),
          },
        },
      ],
    },
  };
}

// The endpoints alone, with nothing for any to name but the private APIs given.
function endpointsStack(invokableApis: PrivateApiAccess) {
  const zones = ["eu-west-2a", "eu-west-2b"];
  const stack = new ZonedStack(cdkApp(), zones);
  const { vpc, subnets } = new NetworkVpc(stack, "Network", {
    environment: "sandbox",
    zones,
    natAddresses: new NatAddresses(stack, "NatAddresses", {
      environment: "sandbox",
      zones,
    }),
  });
  new InterfaceEndpoints(stack, "Endpoints", {
    vpc,
    subnets: subnets.isolated,
    invokableFunctions: "gateway-sandbox-*:live",
    readableObjects: [],
    readableTables: [],
    readableSecrets: [],
    assumableRoles: [],
    gatewayRoles: "gateway-sandbox-*-execution",
    invokableApis,
  });
  return stack;
}

describe("InterfaceEndpoints", () => {
  it.each([
    [
      "lambda",
      "lambda:InvokeFunction",
      `arn:aws:lambda:eu-west-2:${ACCOUNT}:function:gateway-sandbox-*:live`,
    ],
    [
      "secretsmanager",
      "secretsmanager:GetSecretValue",
      UPSTREAM_SECRET,
      undefined,
      // Only gateways read secrets, assume roles and read the caller token's public keys, so
      // nothing else in the account may.
      GATEWAY_ROLES,
    ],
    ["sts", "sts:AssumeRole", UPSTREAM_ROLE, undefined, GATEWAY_ROLES],
    [
      "s3",
      "s3:GetObject",
      `arn:aws:s3:::${KEYS_OBJECT.bucket}/${KEYS_OBJECT.key}`,
      // Bucket names are global, so the bucket's owner is named too.
      KEYS_OBJECT.account,
    ],
    // DynamoDB's endpoint has no private DNS.
    ["dynamodb", "dynamodb:Scan", KEYS_TABLE, undefined, GATEWAY_ROLES, false],
  ])(
    "has a %s endpoint in the isolated subnets, for this account, one action and what it names",
    (
      service,
      action,
      resource,
      resourceAccount?: string,
      principals?: string,
      privateDns?: boolean,
    ) => {
      buildNetwork().template.hasResourceProperties(
        "AWS::EC2::VPCEndpoint",
        endpoint(
          service,
          action,
          resource,
          resourceAccount,
          principals,
          privateDns,
        ),
      );
    },
  );

  it("has an execute-api endpoint that lets a principal of an upstream's account, and no other, invoke its private API", () => {
    Template.fromStack(buildNetwork().stack).hasResourceProperties(
      "AWS::EC2::VPCEndpoint",
      {
        ServiceName: "com.amazonaws.eu-west-2.execute-api",
        VpcEndpointType: "Interface",
        PrivateDnsEnabled: true,
        PolicyDocument: {
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: "*" },
              Action: "execute-api:Invoke",
              Resource: `${UPSTREAM_API}/*`,
              // The role is the upstream's, so no condition holds the caller to this account.
              Condition: {
                StringEquals: { "aws:PrincipalAccount": [UPSTREAM_ACCOUNT] },
              },
            },
          ],
        },
      },
    );
  });

  it("names every private API in one statement, however many there are, so the policy grows by an ARN for each", () => {
    const access = {
      apiArns: [
        UPSTREAM_API,
        "arn:aws:execute-api:eu-west-2:300000000001:f6g7h8i9j0",
        "arn:aws:execute-api:eu-west-2:300000000001:k1l2m3n4o5",
      ],
      callerAccounts: [UPSTREAM_ACCOUNT, "300000000001"],
    };
    const stack = endpointsStack(access);

    Template.fromStack(stack).hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-west-2.execute-api",
      PolicyDocument: {
        Statement: [
          {
            Resource: access.apiArns.map((arn) => `${arn}/*`),
            Condition: {
              StringEquals: { "aws:PrincipalAccount": access.callerAccounts },
            },
          },
        ],
      },
    });
  });

  it("refuses a private API with no account a call to it may be signed in", () => {
    expect(() =>
      endpointsStack({ apiArns: [UPSTREAM_API], callerAccounts: [] }),
    ).toThrow(
      "A private API is named with no account a call to it may be signed in.",
    );
  });

  it("has no other endpoint", () => {
    Template.fromStack(buildNetwork().stack).resourceCountIs(
      "AWS::EC2::VPCEndpoint",
      6,
    );
  });

  it("gives each endpoint a group of its own, which lets nothing out and lets in only workloads", () => {
    const { template } = buildNetwork();
    const groups = Object.values(
      template.findResources("AWS::EC2::SecurityGroup", {
        Properties: {
          GroupDescription: Match.stringLikeRegexp("interface endpoint$"),
        },
      }),
    ) as { Properties: Record<string, unknown> }[];

    expect(groups).toHaveLength(6);
    for (const group of groups) {
      expect(group.Properties).not.toHaveProperty("SecurityGroupIngress");
      expect(group.Properties.SecurityGroupEgress).toEqual([
        expect.objectContaining({ CidrIp: "255.255.255.255/32" }),
      ]);
    }
  });

  it("gives the names the SDK calls each endpoint's API at, for the DNS allowlist, and none for execute-api, where an API has its own, or dynamodb, which has no private DNS", () => {
    const { stack } = buildNetwork();
    const endpoints = stack.node.findChild("Endpoints") as InterfaceEndpoints;

    expect(endpoints.hostnames).toEqual([
      "lambda.eu-west-2.amazonaws.com",
      "secretsmanager.eu-west-2.amazonaws.com",
      "sts.eu-west-2.amazonaws.com",
      `${KEYS_OBJECT.bucket}.s3.eu-west-2.amazonaws.com`,
    ]);
  });

  it("answers the VPC's own lookups of S3's names, with no gateway endpoint beside it", () => {
    Template.fromStack(buildNetwork().stack).hasResourceProperties(
      "AWS::EC2::VPCEndpoint",
      {
        ServiceName: "com.amazonaws.eu-west-2.s3",
        DnsOptions: {
          PrivateDnsOnlyForInboundResolverEndpoint: "AllResolvers",
        },
      },
    );
  });

  it("gives the dynamodb endpoint's own regional name, the first AWS lists, without its hosted zone", () => {
    const { stack } = buildNetwork();
    const endpoints = stack.node.findChild("Endpoints") as InterfaceEndpoints;

    expect(stack.resolve(endpoints.dynamoDbAddress)).toEqual({
      "Fn::Select": [
        1,
        {
          "Fn::Split": [
            ":",
            {
              "Fn::Select": [
                0,
                {
                  "Fn::GetAtt": [
                    expect.stringMatching("^EndpointsDynamoDb"),
                    "DnsEntries",
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("refuses everything through an endpoint with nothing to name", () => {
    const stack = endpointsStack({ apiArns: [], callerAccounts: [] });

    for (const service of [
      "secretsmanager",
      "sts",
      "s3",
      "dynamodb",
      "execute-api",
    ]) {
      Template.fromStack(stack).hasResourceProperties("AWS::EC2::VPCEndpoint", {
        ServiceName: `com.amazonaws.eu-west-2.${service}`,
        PolicyDocument: {
          Statement: [
            {
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "*",
              Resource: "*",
            },
          ],
        },
      });
    }
  });
});
