import { Match, type Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, buildNetwork, UPSTREAM } from "../../test/network.ts";

type Resources = Record<
  string,
  { Type: string; Properties: Record<string, unknown> }
>;

function resources(template: Template, type: string): Resources {
  return template.findResources(type) as Resources;
}

const BASELINE = [
  "lambda.eu-west-2.amazonaws.com",
  "secretsmanager.eu-west-2.amazonaws.com",
  "sts.eu-west-2.amazonaws.com",
];

describe("DnsFirewall", () => {
  it("allows the endpoints' names and the upstream's, sorted, and nothing broader", () => {
    buildNetwork().template.hasResourceProperties(
      "AWS::Route53Resolver::FirewallDomainList",
      {
        Name: "network-sandbox-dns-allowed",
        Domains: ["api.upstream.example", "auth.upstream.example", ...BASELINE],
      },
    );
  });

  it("allows the listed names first, trusting where they alias to, then blocks every name with NXDOMAIN", () => {
    const { template } = buildNetwork();

    template.hasResourceProperties("AWS::Route53Resolver::FirewallRuleGroup", {
      Name: "network-sandbox-dns-allow",
      FirewallRules: [
        {
          Priority: 100,
          Action: "ALLOW",
          FirewallDomainListId: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("^DnsFirewallAllowedNames"),
              "Id",
            ],
          },
          FirewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN",
        },
      ],
    });
    template.hasResourceProperties("AWS::Route53Resolver::FirewallDomainList", {
      Name: "network-sandbox-dns-every-name",
      Domains: ["*"],
    });
    // No Qtype, so the block covers every query type.
    template.hasResourceProperties("AWS::Route53Resolver::FirewallRuleGroup", {
      Name: "network-sandbox-dns-block",
      FirewallRules: [
        {
          Priority: 100,
          Action: "BLOCK",
          BlockResponse: "NXDOMAIN",
          FirewallDomainListId: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("^DnsFirewallEveryName"),
              "Id",
            ],
          },
          FirewallDomainRedirectionAction: "INSPECT_REDIRECTION_DOMAIN",
          Qtype: Match.absent(),
        },
      ],
    });
  });

  it("associates both groups with the VPC, the allowlist evaluated before the block", () => {
    const associations = Object.values(
      resources(
        buildNetwork().template,
        "AWS::Route53Resolver::FirewallRuleGroupAssociation",
      ),
    ).map(({ Properties }) => Properties);

    expect(associations).toHaveLength(2);
    const allow = associations.find(
      ({ Name }) => Name === "network-sandbox-dns-allow",
    );
    const block = associations.find(
      ({ Name }) => Name === "network-sandbox-dns-block",
    );
    for (const association of [allow, block]) {
      expect((association?.VpcId as { Ref: string }).Ref).toMatch(
        /^NetworkVpc/,
      );
    }
    expect(allow?.Priority).toBeLessThan(block?.Priority as number);
  });

  // The block's group, list and association can't depend on the allowlist, so changing or rolling
  // back the allowlist never touches them, or anything else.
  it("changes nothing but the allowlist when the names change, so the block stays in place", () => {
    const before = buildNetwork().template.toJSON().Resources as Resources;
    const after = buildNetwork(undefined, false, {
      hostnames: ["api.other.example"],
    }).template.toJSON().Resources as Resources;
    const changed = Object.keys({ ...before, ...after }).filter(
      (id) => JSON.stringify(before[id]) !== JSON.stringify(after[id]),
    );

    expect(changed).toEqual([
      expect.stringMatching(/^DnsFirewallAllowedNames/),
    ]);
  });

  it("allows only the names it's given, without repeats", () => {
    const { template } = buildNetwork(undefined, false, {
      hostnames: ["auth.upstream.example", "AUTH.upstream.example."],
    });

    template.hasResourceProperties("AWS::Route53Resolver::FirewallDomainList", {
      Name: "network-sandbox-dns-allowed",
      Domains: ["auth.upstream.example", ...BASELINE],
    });
  });

  it("refuses an unsafe name", () => {
    expect(() =>
      buildNetwork(undefined, false, {
        hostnames: [...UPSTREAM.hostnames, "https://api.upstream.example"],
      }),
    ).toThrow("is a URL");
  });

  it("sets the VPC to fail closed, explicitly, with CloudFormation's own resource", () => {
    const { template } = buildNetwork();

    template.hasResourceProperties("AWS::Route53Resolver::FirewallConfig", {
      ResourceId: { Ref: Match.stringLikeRegexp("^NetworkVpc") },
      FirewallFailOpen: "DISABLED",
    });
    template.resourceCountIs("Custom::AWS", 0);
  });

  it("logs the VPC's resolver queries to a log group of the platform's", () => {
    const { template } = buildNetwork();

    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/flex/network/sandbox/dns-queries",
    });
    template.hasResourceProperties(
      "AWS::Route53Resolver::ResolverQueryLoggingConfig",
      {
        DestinationArn: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("^DnsFirewallQueryLogs"),
            "Arn",
          ],
        },
      },
    );
    template.hasResourceProperties(
      "AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation",
      {
        ResolverQueryLogConfigId: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("^DnsFirewallQueryLogging"),
            "Id",
          ],
        },
        ResourceId: { Ref: Match.stringLikeRegexp("^NetworkVpc") },
      },
    );
  });

  it("lets only this account's log delivery write the query logs", () => {
    const [policy] = Object.values(
      resources(buildNetwork().template, "AWS::Logs::ResourcePolicy"),
    );
    // The document is a string joined around the log group's ARN.
    const document = JSON.stringify(policy?.Properties.PolicyDocument);

    for (const part of [
      '\\"Principal\\":{\\"Service\\":\\"delivery.logs.amazonaws.com\\"}',
      '\\"Action\\":[\\"logs:CreateLogStream\\",\\"logs:PutLogEvents\\"]',
      `\\"StringEquals\\":{\\"aws:SourceAccount\\":\\"${ACCOUNT}\\"}`,
      `\\"ArnLike\\":{\\"aws:SourceArn\\":\\"arn:aws:logs:eu-west-2:${ACCOUNT}:*\\"}`,
      '"DnsFirewallQueryLogsLogGroup',
    ]) {
      expect(document).toContain(part);
    }
  });

  it("alarms on any blocked query, with no action until alerting exists", () => {
    buildNetwork().template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "network-sandbox-dns-blocked-queries",
      Namespace: "AWS/Route53Resolver",
      MetricName: "FirewallRuleQueryVolume",
      Dimensions: [
        {
          Name: "FirewallDomainListId",
          Value: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("^DnsFirewallEveryName"),
              "Id",
            ],
          },
        },
        {
          Name: "FirewallRuleGroupId",
          Value: {
            "Fn::GetAtt": [Match.stringLikeRegexp("^DnsFirewallBlock"), "Id"],
          },
        },
      ],
      Statistic: "Sum",
      Period: 300,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: Match.absent(),
    });
  });
});
