import { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { describe, expect, it } from "vitest";

import { stackIn } from "../../test/cloudfront.ts";
import { deliverAccessLogs } from "./access-logs.ts";
import { apexAliases, apexCertificate } from "./apex.ts";

const ZONE = {
  zoneName: "example.flex.example",
  hostedZoneId: "Z100000000002",
};

// A distribution at a zone's apex, with everything these functions add beside it.
function build(checks = false) {
  const { app, stack } = stackIn("us-east-1", checks);
  const zone = HostedZone.fromHostedZoneAttributes(stack, "Zone", ZONE);
  const certificate = apexCertificate(stack, zone, ZONE.zoneName);
  const distribution = new Distribution(stack, "Distribution", {
    domainNames: [ZONE.zoneName],
    certificate,
    defaultBehavior: {
      origin: new HttpOrigin("origin.example", { originId: "default" }),
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
    },
  });
  const logGroup = deliverAccessLogs(stack, {
    name: "example-access-logs",
    distribution,
  });
  apexAliases(stack, zone, ZONE.zoneName, distribution);
  return { app, stack, logGroup, template: () => Template.fromStack(stack) };
}

describe("apexCertificate", () => {
  it("validates a certificate for the apex in the zone it is given, creating no zone", () => {
    const built = build().template();

    built.resourceCountIs("AWS::Route53::HostedZone", 0);
    built.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: ZONE.zoneName,
      ValidationMethod: "DNS",
      DomainValidationOptions: [
        { DomainName: ZONE.zoneName, HostedZoneId: ZONE.hostedZoneId },
      ],
    });
  });

  // ACM checks CAA before it issues.
  it("lets only Amazon issue for the zone, before the certificate is asked for", () => {
    const built = build().template();

    const [caaId] = Object.keys(
      built.findResources("AWS::Route53::RecordSet", {
        Properties: { Type: "CAA" },
      }),
    );
    built.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "CAA",
      Name: `${ZONE.zoneName}.`,
      HostedZoneId: ZONE.hostedZoneId,
      ResourceRecords: ['0 issue "amazon.com"'],
    });
    built.hasResource("AWS::CertificateManager::Certificate", {
      DependsOn: Match.arrayWith([caaId]),
    });
  });
});

describe("apexAliases", () => {
  it.each(["A", "AAAA"])(
    "writes an %s alias to the distribution at the apex",
    (type) => {
      build()
        .template()
        .hasResourceProperties("AWS::Route53::RecordSet", {
          Type: type,
          Name: `${ZONE.zoneName}.`,
          HostedZoneId: ZONE.hostedZoneId,
          AliasTarget: {
            DNSName: {
              "Fn::GetAtt": [
                Match.stringLikeRegexp("Distribution"),
                "DomainName",
              ],
            },
          },
        });
    },
  );

  it("writes nothing else in the zone", () => {
    build().template().resourceCountIs("AWS::Route53::RecordSet", 3);
  });
});

describe("deliverAccessLogs", () => {
  it("delivers the distribution's access logs to a retained log group through standard logging v2", () => {
    const { logGroup, stack, template } = build();
    const built = template();
    const logGroupArn = stack.resolve(logGroup.logGroupArn) as unknown;

    built.hasResourceProperties("AWS::Logs::DeliverySource", {
      Name: "example-access-logs",
      LogType: "ACCESS_LOGS",
      ResourceArn: Match.objectLike({
        "Fn::Join": Match.arrayWith([
          Match.arrayWith([{ Ref: Match.stringLikeRegexp("Distribution") }]),
        ]),
      }),
    });
    built.hasResourceProperties("AWS::Logs::DeliveryDestination", {
      Name: "example-access-logs",
      DeliveryDestinationType: "CWL",
      DestinationResourceArn: logGroupArn,
    });
    built.hasResource("AWS::Logs::Delivery", {
      Properties: { DeliverySourceName: "example-access-logs" },
      DependsOn: Match.arrayWith(["AccessLogPolicy", "AccessLogSource"]),
    });
    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: { RetentionInDays: 365 },
    });
  });

  // The account's resource policy is what lets the delivery service write.
  it("lets the delivery service write to that log group, for this source alone", () => {
    const { stack, template } = build();
    const [policy] = Object.values(
      template().findResources("AWS::Logs::ResourcePolicy"),
    );
    const properties = policy?.Properties as {
      PolicyName: string;
      PolicyDocument: unknown;
    };

    expect(properties.PolicyName).toBe("example-access-logs");
    const document = JSON.stringify(properties.PolicyDocument);
    expect(document).toContain("delivery.logs.amazonaws.com");
    expect(document).toContain("logs:PutLogEvents");
    expect(document).toContain(
      `arn:aws:logs:us-east-1:${Stack.of(stack).account}:delivery-source/example-access-logs`,
    );
  });

  it("keeps its IDs in the scope it is given, where a distribution's construct holds them", () => {
    const { stack } = build();

    for (const id of [
      "AccessLogs",
      "AccessLogSource",
      "AccessLogPolicy",
      "AccessLogDestination",
      "AccessLogDelivery",
      "Caa",
      "Certificate",
      "AliasIpv4",
      "AliasIpv6",
    ]) {
      expect(stack.node.tryFindChild(id), id).toBeDefined();
    }
  });
});
