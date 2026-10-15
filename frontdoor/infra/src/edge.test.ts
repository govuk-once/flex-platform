import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { edgeIn, edgeTemplate, stackIn, ZONE } from "../test/helpers.ts";
import { CONTENT_SECURITY_POLICY } from "./response-headers-policy.ts";

describe("Edge", () => {
  it("refuses any region but us-east-1", () => {
    expect(() => edgeIn(stackIn("eu-west-2"))).toThrow("us-east-1");
  });

  it("has no unacknowledged cdk-nag finding", () => {
    const { app } = edgeTemplate(true);

    expect(() => app.synth()).not.toThrow();
  });

  it("answers at its zone's apex, with a certificate for it, behind the web ACL", () => {
    const { edge, template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Enabled: true,
        HttpVersion: "http2and3",
        PriceClass: "PriceClass_100",
        WebACLId: { "Fn::GetAtt": [Match.stringLikeRegexp("WebAcl"), "Arn"] },
        Aliases: [ZONE.zoneName],
        ViewerCertificate: {
          AcmCertificateArn: { Ref: Match.stringLikeRegexp("Certificate") },
          MinimumProtocolVersion: "TLSv1.2_2025",
          SslSupportMethod: "sni-only",
        },
      }),
    });
    expect(edge.url).toBe(`https://${ZONE.zoneName}`);
  });

  it("validates its certificate in the zone it is given, creating no zone", () => {
    const { template } = edgeTemplate();

    template.resourceCountIs("AWS::Route53::HostedZone", 0);
    template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: ZONE.zoneName,
      ValidationMethod: "DNS",
      DomainValidationOptions: [
        { DomainName: ZONE.zoneName, HostedZoneId: ZONE.hostedZoneId },
      ],
    });
    // ACM checks CAA before it issues.
    const [caa] = Object.keys(
      template.findResources("AWS::Route53::RecordSet", {
        Properties: { Type: "CAA" },
      }),
    );
    template.hasResource("AWS::CertificateManager::Certificate", {
      DependsOn: [caa],
    });
    // Anything more would be a name the certificate doesn't cover.
    const [certificate] = Object.values(
      template.findResources("AWS::CertificateManager::Certificate"),
    );
    expect(
      (certificate?.Properties as { SubjectAlternativeNames?: unknown })
        .SubjectAlternativeNames,
    ).toBeUndefined();
  });

  it("writes an alias for IPv4 and IPv6 and a CAA record at the apex, and nothing else", () => {
    const { template } = edgeTemplate();

    const records = Object.values(
      template.findResources("AWS::Route53::RecordSet"),
    ).map(
      (record) =>
        record.Properties as {
          Type: string;
          Name: string;
          HostedZoneId: string;
        },
    );
    expect(records.map(({ Type }) => Type).sort()).toEqual([
      "A",
      "AAAA",
      "CAA",
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        Name: `${ZONE.zoneName}.`,
        HostedZoneId: ZONE.hostedZoneId,
      });
    }
    for (const type of ["A", "AAAA"]) {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Type: type,
        AliasTarget: {
          DNSName: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("Distribution"),
              "DomainName",
            ],
          },
          HostedZoneId: Match.anyValue(),
        },
      });
    }
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "CAA",
      ResourceRecords: ['0 issue "amazon.com"'],
    });
  });

  it("sends every path to the one default origin, caching nothing", () => {
    const { template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Origins: [
          Match.objectLike({
            DomainName: {
              "Fn::GetAtt": [
                Match.stringLikeRegexp("DefaultOrigin"),
                "RegionalDomainName",
              ],
            },
            S3OriginConfig: { OriginAccessIdentity: "" },
          }),
        ],
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "https-only",
          AllowedMethods: [
            "GET",
            "HEAD",
            "OPTIONS",
            "PUT",
            "PATCH",
            "POST",
            "DELETE",
          ],
          // CachingDisabled, which AWS manages.
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          OriginRequestPolicyId: {
            Ref: Match.stringLikeRegexp("OriginRequest"),
          },
        }),
      },
    });
    const [distribution] = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const config = (
      distribution?.Properties as {
        DistributionConfig: {
          Origins: { OriginAccessControlId?: unknown }[];
          CacheBehaviors?: unknown;
        };
      }
    ).DistributionConfig;
    expect(config.Origins).toHaveLength(1);
    expect(config.Origins[0]?.OriginAccessControlId).toBeUndefined();
    expect(config.CacheBehaviors).toBeUndefined();
  });

  it("forwards four headers and every query string to the origin, and no cookies", () => {
    const { template } = edgeTemplate();

    template.resourceCountIs("AWS::CloudFront::OriginRequestPolicy", 1);
    template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: {
        Name: Match.stringLikeRegexp("OriginRequest"),
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: [
            "authorization",
            "content-type",
            "accept",
            "x-correlation-id",
          ],
        },
        QueryStringsConfig: { QueryStringBehavior: "all" },
        CookiesConfig: { CookieBehavior: "none" },
      },
    });
  });

  it("keeps an empty, private default origin, which nothing signs requests to", () => {
    const { template } = edgeTemplate();

    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      }),
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 0);
    template.resourceCountIs(
      "AWS::CloudFront::CloudFrontOriginAccessIdentity",
      0,
    );
    // The bucket policy holds the platform's HTTPS and TLS denials, and grants nothing.
    const [policy] = Object.values(
      template.findResources("AWS::S3::BucketPolicy"),
    );
    const statements = (
      policy?.Properties as {
        PolicyDocument: { Statement: { Effect: string }[] };
      }
    ).PolicyDocument.Statement;
    expect(statements.map((statement) => statement.Effect)).toEqual([
      "Deny",
      "Deny",
    ]);
  });

  it("runs the given CloudFront Function on every viewer request", () => {
    const { template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [
            {
              EventType: "viewer-request",
              FunctionARN: {
                "Fn::GetAtt": [
                  Match.stringLikeRegexp("ViewerRequest"),
                  "FunctionARN",
                ],
              },
            },
          ],
        }),
      },
    });
  });

  it("runs the given Lambda@Edge version at origin request, without the body", () => {
    const { template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultCacheBehavior: Match.objectLike({
          LambdaFunctionAssociations: [
            {
              EventType: "origin-request",
              IncludeBody: false,
              LambdaFunctionARN: {
                Ref: Match.stringLikeRegexp(
                  "OriginRequestFunctionCurrentVersion",
                ),
              },
            },
          ],
        }),
      },
    });
  });

  it("sets the security headers on every response, keeps it out of caches, and strips API Gateway's", () => {
    const { template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: {
          ContentSecurityPolicy: {
            ContentSecurityPolicy: CONTENT_SECURITY_POLICY,
            Override: true,
          },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ReferrerPolicy: { ReferrerPolicy: "no-referrer", Override: true },
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 31536000,
            IncludeSubdomains: true,
            Override: true,
          },
        },
        CustomHeadersConfig: {
          Items: [
            {
              Header: "X-Permitted-Cross-Domain-Policies",
              Value: "none",
              Override: true,
            },
            { Header: "Cache-Control", Value: "no-store", Override: true },
            {
              Header: "Cross-Origin-Resource-Policy",
              Value: "same-origin",
              Override: true,
            },
          ],
        },
        RemoveHeadersConfig: {
          Items: [
            { Header: "x-amz-apigw-id" },
            { Header: "x-amzn-trace-id" },
            { Header: "x-amzn-remapped-authorization" },
            { Header: "x-amzn-remapped-connection" },
            { Header: "x-amzn-remapped-content-md5" },
            { Header: "x-amzn-remapped-date" },
            { Header: "x-amzn-remapped-max-forwards" },
            { Header: "x-amzn-remapped-server" },
            { Header: "x-amzn-remapped-user-agent" },
            { Header: "x-amzn-remapped-www-authenticate" },
          ],
        },
      },
    });
  });

  it("delivers access logs to a retained log group through standard logging v2", () => {
    const { edge, template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.not(
        Match.objectLike({ Logging: Match.anyValue() }),
      ),
    });
    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: Match.not(
        Match.objectLike({ LogGroupName: Match.anyValue() }),
      ),
    });
    template.hasResourceProperties("AWS::Logs::DeliverySource", {
      Name: "frontdoor-sandbox-access-logs",
      LogType: "ACCESS_LOGS",
      ResourceArn: {
        "Fn::Join": [
          "",
          Match.arrayWith([
            Match.stringLikeRegexp(":cloudfront::"),
            { Ref: Match.stringLikeRegexp("Distribution") },
          ]),
        ],
      },
    });
    template.hasResourceProperties("AWS::Logs::DeliveryDestination", {
      Name: "frontdoor-sandbox-access-logs",
      DeliveryDestinationType: "CWL",
      DestinationResourceArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("AccessLogs"), "Arn"],
      },
    });
    template.hasResourceProperties("AWS::Logs::Delivery", {
      DeliverySourceName: "frontdoor-sandbox-access-logs",
      DeliveryDestinationArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("AccessLogDestination"), "Arn"],
      },
    });
    template.hasResourceProperties("AWS::Logs::ResourcePolicy", {
      PolicyName: "frontdoor-sandbox-access-logs",
    });
    const [policy] = Object.values(
      template.findResources("AWS::Logs::ResourcePolicy"),
    );
    const document = JSON.stringify(
      (policy?.Properties as { PolicyDocument: unknown }).PolicyDocument,
    );
    expect(document).toContain("delivery.logs.amazonaws.com");
    expect(document).toContain("logs:PutLogEvents");
    expect(document).toContain("aws:SourceAccount");
    expect(document).toContain("delivery-source/frontdoor-sandbox-access-logs");
    expect(edge.accessLogGroup.logGroupName).toBeTruthy();
  });
});
