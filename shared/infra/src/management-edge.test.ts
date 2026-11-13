import { CONTENT_SECURITY_POLICY } from "@repo/infra-constructs";
import { CI_TOKEN_HEADER } from "@repo/shared-viewer-request";
import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  CI_ORIGIN_HOST,
  managementEdgeIn,
  managementEdgeTemplate,
  stackIn,
  ZONE,
} from "../test/helpers.ts";
import { FORWARDED_HEADERS, REDACTED_HEADERS } from "./management-edge.ts";

interface Rule {
  Name: string;
  Statement: {
    RateBasedStatement?: {
      Limit: number;
      CustomKeys?: { Header: { Name: string } }[];
    };
  };
}

describe("ManagementEdge", () => {
  it("refuses any region but us-east-1", () => {
    // Its function refuses the region too, so it is built where it belongs.
    expect(() =>
      managementEdgeIn(stackIn("eu-west-2"), stackIn("us-east-1")),
    ).toThrow("The management distribution must be created in us-east-1");
  });

  it("has no unacknowledged cdk-nag finding", () => {
    const { app } = managementEdgeTemplate(true);

    expect(() => app.synth()).not.toThrow();
  });

  it("answers at its zone's apex, with a certificate for it, behind the web ACL", () => {
    const { edge, template } = managementEdgeTemplate();

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
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: ZONE.zoneName,
      DomainValidationOptions: [
        { DomainName: ZONE.zoneName, HostedZoneId: ZONE.hostedZoneId },
      ],
    });
    expect(edge.url).toBe(`https://${ZONE.zoneName}`);
  });

  it("writes an alias for IPv4 and IPv6 and a CAA record at the apex, creating no zone", () => {
    const { template } = managementEdgeTemplate();

    template.resourceCountIs("AWS::Route53::HostedZone", 0);
    template.resourceCountIs("AWS::Route53::RecordSet", 3);
    for (const Type of ["A", "AAAA", "CAA"]) {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Type,
        Name: `${ZONE.zoneName}.`,
        HostedZoneId: ZONE.hostedZoneId,
      });
    }
  });

  // The CloudFront Function refuses any path that isn't the pipeline API's before it gets here.
  it("sends every path to the pipeline API over HTTPS, caching nothing", () => {
    const { template } = managementEdgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: [
          Match.objectLike({
            Id: "ci",
            DomainName: CI_ORIGIN_HOST,
            CustomOriginConfig: {
              OriginProtocolPolicy: "https-only",
              OriginSSLProtocols: ["TLSv1.2"],
            },
          }),
        ],
        CacheBehaviors: Match.absent(),
        DefaultCacheBehavior: Match.objectLike({
          TargetOriginId: "ci",
          ViewerProtocolPolicy: "https-only",
          // CloudFront's managed CachingDisabled policy.
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          AllowedMethods: Match.arrayWith(["POST"]),
        }),
      }),
    });
  });

  // The function URL takes no unsigned request, so without this every request would be refused.
  it("signs every request to the pipeline API, replacing any Authorization a caller sent", () => {
    const { template } = managementEdgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: {
        Name: "shared-management-ci",
        OriginAccessControlOriginType: "lambda",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      },
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: [
          Match.objectLike({
            OriginAccessControlId: {
              "Fn::GetAtt": [
                Match.stringLikeRegexp("CiOriginAccessControl"),
                "Id",
              ],
            },
          }),
        ],
      }),
    });
  });

  it("forwards four headers to the pipeline API, and no cookies or query strings", () => {
    const { template } = managementEdgeTemplate();

    expect(FORWARDED_HEADERS).toEqual([
      "x-flex-ci-token",
      "content-type",
      "x-amz-content-sha256",
      "x-correlation-id",
    ]);
    template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: {
        Name: "shared-management-ci-headers",
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: [...FORWARDED_HEADERS],
        },
        QueryStringsConfig: { QueryStringBehavior: "none" },
        CookiesConfig: { CookieBehavior: "none" },
      },
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          OriginRequestPolicyId: {
            Ref: Match.stringLikeRegexp("CiOriginRequest"),
          },
        }),
      }),
    });
  });

  // The function URL answers only to its own host, so the viewer's must never be forwarded.
  it("never forwards the viewer's host", () => {
    expect(FORWARDED_HEADERS).not.toContain("host");
  });

  it("runs the given CloudFront Function on every viewer request", () => {
    const { template } = managementEdgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [
            {
              EventType: "viewer-request",
              FunctionARN: {
                "Fn::GetAtt": [
                  Match.stringLikeRegexp("ViewerRequestFunction"),
                  "FunctionARN",
                ],
              },
            },
          ],
          LambdaFunctionAssociations: Match.absent(),
        }),
      }),
    });
  });

  it("sets the security headers on every response, keeps it out of caches, and strips Lambda's trace header", () => {
    const { template } = managementEdgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: "shared-management-response-headers",
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: {
            ContentSecurityPolicy: CONTENT_SECURITY_POLICY,
            Override: true,
          },
        }),
        RemoveHeadersConfig: { Items: [{ Header: "x-amzn-trace-id" }] },
      }),
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ResponseHeadersPolicyId: {
            Ref: Match.stringLikeRegexp("ResponseHeaders"),
          },
        }),
      }),
    });
  });

  // The limit's key is the token header's exact value, which the CloudFront Function holds to
  // one form per token.
  it("limits each pipeline token to 100 requests and each address to 500 in five minutes", () => {
    const { edge, template } = managementEdgeTemplate();
    const [webAcl] = Object.values(
      template.findResources("AWS::WAFv2::WebACL"),
    );
    const { Name, Rules } = webAcl?.Properties as {
      Name: string;
      Rules: Rule[];
    };
    const rate = (name: string) =>
      Rules.find((rule) => rule.Name === name)?.Statement.RateBasedStatement;

    expect(Name).toBe("shared-management-web-acl");
    expect(edge.webAcl.ruleNames).toHaveLength(7);
    expect(rate("RateLimitPerToken")).toMatchObject({
      Limit: 100,
      CustomKeys: [{ Header: { Name: CI_TOKEN_HEADER } }],
    });
    expect(rate("RateLimitPerIp")).toMatchObject({ Limit: 500 });
  });

  // A token in a log is a token anyone who reads the log can use until it expires.
  it("keeps the pipeline's token out of the web ACL's logs and samples", () => {
    const { template } = managementEdgeTemplate();

    expect(REDACTED_HEADERS).toEqual([
      "x-flex-ci-token",
      "authorization",
      "cookie",
    ]);
    template.hasResourceProperties("AWS::WAFv2::LoggingConfiguration", {
      RedactedFields: REDACTED_HEADERS.map((Name) => ({
        SingleHeader: { Name },
      })),
    });
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      DataProtectionConfig: {
        DataProtections: Match.arrayWith([
          Match.objectLike({
            Action: "SUBSTITUTION",
            Field: {
              FieldType: "SINGLE_HEADER",
              FieldKeys: ["x-flex-ci-token"],
            },
          }),
        ]),
      },
    });
  });

  it("delivers access logs to a retained log group through standard logging v2", () => {
    const { template } = managementEdgeTemplate();

    template.hasResourceProperties("AWS::Logs::DeliverySource", {
      Name: "shared-management-access-logs",
      LogType: "ACCESS_LOGS",
    });
    template.hasResourceProperties("AWS::Logs::DeliveryDestination", {
      Name: "shared-management-access-logs",
      DeliveryDestinationType: "CWL",
    });
    template.resourceCountIs("AWS::Logs::Delivery", 1);
  });
});
