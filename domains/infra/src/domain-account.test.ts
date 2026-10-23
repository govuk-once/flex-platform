import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT,
  domainAccountIn,
  domainAccountTemplate,
  stackIn,
  ZONE,
} from "../test/helpers.ts";

const ARN = `eu-west-2:${ACCOUNT}`;

const FUNCTION_LOG_GROUP = `arn:aws:logs:${ARN}:log-group:/flex/domain/sandbox/function`;

const LOG_GROUP_KEY = {
  "Fn::GetAtt": [Match.stringLikeRegexp("^LogGroupKey"), "Arn"],
};

const EXECUTION_STATEMENTS = [
  {
    Action: "lambda:InvokeFunction",
    Effect: "Allow",
    Resource: `arn:aws:lambda:${ARN}:function:gateway-sandbox-*`,
  },
  {
    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
    Effect: "Allow",
    Resource: `${FUNCTION_LOG_GROUP}:*`,
  },
  {
    Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
    Effect: "Allow",
    Resource: LOG_GROUP_KEY,
    Condition: {
      StringEquals: { "kms:ViaService": "logs.eu-west-2.amazonaws.com" },
      ArnEquals: { "kms:EncryptionContext:aws:logs:arn": FUNCTION_LOG_GROUP },
    },
  },
  {
    Action: [
      "ec2:AssignPrivateIpAddresses",
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSubnets",
      "ec2:UnassignPrivateIpAddresses",
    ],
    Effect: "Allow",
    Resource: "*",
  },
];

function roleNamed(roleName: string) {
  const { template } = domainAccountTemplate();
  const roles = template.findResources("AWS::IAM::Role", {
    Properties: { RoleName: roleName },
  });
  const [role] = Object.values(roles);

  return {
    template,
    role: role?.Properties as {
      AssumeRolePolicyDocument: unknown;
      Policies: { PolicyDocument: { Statement: unknown[] } }[];
      PermissionsBoundary?: unknown;
    },
  };
}

describe("DomainAccount", () => {
  it("refuses any region but eu-west-2", () => {
    expect(() => domainAccountIn(stackIn("us-east-1"))).toThrow("eu-west-2");
  });

  it("has no unacknowledged cdk-nag finding", () => {
    const { app } = domainAccountTemplate(true);

    expect(() => app.synth()).not.toThrow();
  });

  describe("the certificate", () => {
    it("is one wildcard for the zone, validated in that zone, creating no zone", () => {
      const { template } = domainAccountTemplate();

      template.resourceCountIs("AWS::Route53::HostedZone", 0);
      template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
      template.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: `*.${ZONE.zoneName}`,
        ValidationMethod: "DNS",
        DomainValidationOptions: [
          {
            DomainName: `*.${ZONE.zoneName}`,
            HostedZoneId: ZONE.hostedZoneId,
          },
        ],
      });
    });

    it("waits for a CAA record at the apex allowing only Amazon", () => {
      const { template } = domainAccountTemplate();

      const records = template.findResources("AWS::Route53::RecordSet", {
        Properties: {
          Type: "CAA",
          Name: `${ZONE.zoneName}.`,
          ResourceRecords: ['0 issue "amazon.com"'],
        },
      });
      const [caa] = Object.keys(records);

      template.resourceCountIs("AWS::Route53::RecordSet", 1);
      template.hasResource("AWS::CertificateManager::Certificate", {
        DependsOn: [caa],
      });
    });

    it("publishes its ARN where each domain's stack reads it", () => {
      domainAccountTemplate().template.hasResourceProperties(
        "AWS::SSM::Parameter",
        {
          Name: "/flex/domain/sandbox/certificate-arn",
          Value: { Ref: Match.stringLikeRegexp("Certificate") },
        },
      );
    });
  });

  describe("the security group", () => {
    // Synth stays offline, so each SSM value is a CloudFormation parameter resolved at deploy.
    function parameterFor(name: string) {
      const { template } = domainAccountTemplate();
      const parameters = template.toJSON().Parameters as Record<
        string,
        { Type: string; Default: string }
      >;
      const [id] = Object.entries(parameters).find(
        ([, parameter]) => parameter.Default === name,
      ) ?? [undefined];

      return { template, id };
    }

    it("is created in the VPC named in SSM, letting nothing in", () => {
      const { template, id } = parameterFor("/flex/network/sandbox/vpc-id");

      expect(id).toBeDefined();
      template.resourceCountIs("AWS::EC2::SecurityGroup", 1);
      template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
      template.hasResourceProperties("AWS::EC2::SecurityGroup", {
        VpcId: { Ref: id },
        SecurityGroupIngress: Match.absent(),
      });
    });

    it("may reach only the VPC's Lambda endpoint, over HTTPS", () => {
      const { template, id } = parameterFor(
        "/flex/network/sandbox/lambda-endpoint-security-group-id",
      );

      expect(id).toBeDefined();
      template.resourceCountIs("AWS::EC2::SecurityGroupEgress", 0);
      template.hasResourceProperties("AWS::EC2::SecurityGroup", {
        SecurityGroupEgress: [
          {
            Description: "Invoke gateways through the VPC's Lambda endpoint",
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            DestinationSecurityGroupId: { Ref: id },
          },
        ],
      });
    });

    it("publishes its ID for whatever creates the domains' functions", () => {
      domainAccountTemplate().template.hasResourceProperties(
        "AWS::SSM::Parameter",
        {
          Name: "/flex/domain/sandbox/security-group-id",
          Value: {
            "Fn::GetAtt": [Match.stringLikeRegexp("SecurityGroup"), "GroupId"],
          },
        },
      );
    });
  });

  it("creates the log group every domain's function logs to, named from config", () => {
    domainAccountTemplate().template.hasResourceProperties(
      "AWS::Logs::LogGroup",
      { LogGroupName: "/flex/domain/sandbox/function" },
    );
  });

  describe("the execution role", () => {
    it("is assumed by Lambda alone, with a fixed name", () => {
      const { role } = roleNamed("domain-sandbox-execution");

      expect(role.AssumeRolePolicyDocument).toEqual({
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
          },
        ],
        Version: "2012-10-17",
      });
    });

    it("may invoke the environment's gateways, write its logs and run in a VPC, and nothing else", () => {
      domainAccountTemplate().template.hasResourceProperties("AWS::IAM::Role", {
        RoleName: "domain-sandbox-execution",
        Policies: [
          {
            PolicyName: "Execution",
            PolicyDocument: { Statement: EXECUTION_STATEMENTS },
          },
        ],
      });
    });

    it("is bounded by the same limits", () => {
      const { template, role } = roleNamed("domain-sandbox-execution");

      const boundaries = template.findResources("AWS::IAM::ManagedPolicy");
      const [boundaryId] = Object.keys(boundaries);

      expect(Object.keys(boundaries)).toHaveLength(1);
      expect(role.PermissionsBoundary).toEqual({ Ref: boundaryId });
      template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
        PolicyDocument: { Statement: EXECUTION_STATEMENTS },
      });
    });
  });

  describe("the integration role", () => {
    it("is assumed by API Gateway for this account alone, with a fixed name", () => {
      const { role } = roleNamed("domain-sandbox-integration");

      expect(role.AssumeRolePolicyDocument).toEqual({
        Statement: [
          {
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } },
            Effect: "Allow",
            Principal: { Service: "apigateway.amazonaws.com" },
          },
        ],
        Version: "2012-10-17",
      });
    });

    it("may invoke the live alias of the environment's domain functions, and nothing else", () => {
      const { role } = roleNamed("domain-sandbox-integration");

      expect(role.Policies).toHaveLength(1);
      expect(role.Policies[0]?.PolicyDocument.Statement).toEqual([
        {
          Action: "lambda:InvokeFunction",
          Effect: "Allow",
          Resource: `arn:aws:lambda:${ARN}:function:domain-sandbox-*:live`,
        },
      ]);
    });
  });

  describe("API Gateway's logging", () => {
    const ACCESS_LOGS = `arn:aws:logs:${ARN}:log-group:/flex/domain/sandbox/*/api-access`;
    const EXECUTION_LOGS = `arn:aws:logs:${ARN}:log-group:API-Gateway-Execution-Logs_*/*`;

    it("is set on the account, through a role API Gateway assumes", () => {
      const { template } = domainAccountTemplate();

      template.resourceCountIs("AWS::ApiGateway::Account", 1);
      template.hasResourceProperties("AWS::ApiGateway::Account", {
        CloudWatchRoleArn: {
          "Fn::GetAtt": [Match.stringLikeRegexp("ApiGatewayLogsRole"), "Arn"],
        },
      });
    });

    it("may write only to the domains' API log groups, and create none", () => {
      const { template } = domainAccountTemplate();

      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Principal: { Service: "apigateway.amazonaws.com" },
            }),
          ],
        },
        Policies: [
          {
            PolicyName: "WriteLogs",
            PolicyDocument: {
              Statement: [
                {
                  Action: [
                    "logs:CreateLogStream",
                    "logs:DescribeLogStreams",
                    "logs:PutLogEvents",
                  ],
                  Effect: "Allow",
                  Resource: [`${ACCESS_LOGS}:*`, `${EXECUTION_LOGS}:*`],
                },
                {
                  Action: "logs:DescribeLogGroups",
                  Effect: "Allow",
                  Resource: "*",
                },
                {
                  Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
                  Effect: "Allow",
                  Resource: `arn:aws:kms:${ARN}:key/*`,
                  Condition: {
                    StringEquals: {
                      "kms:ViaService": "logs.eu-west-2.amazonaws.com",
                    },
                    ArnLike: {
                      "kms:EncryptionContext:aws:logs:arn": [
                        ACCESS_LOGS,
                        EXECUTION_LOGS,
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      });
    });
  });

  it("creates nothing a domain is added or removed with", () => {
    const { template } = domainAccountTemplate();

    for (const type of [
      "AWS::ApiGateway::RestApi",
      "AWS::ApiGateway::DomainName",
      "AWS::Lambda::Function",
      "AWS::Lambda::Permission",
    ]) {
      template.resourceCountIs(type, 0);
    }
  });
});
