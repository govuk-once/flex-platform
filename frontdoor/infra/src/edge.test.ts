import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { DOMAIN_NAME, edgeTemplate, stackIn } from "../test/helpers.ts";
import { Edge, FORWARDED_HEADERS } from "./edge.ts";
import { CONTENT_SECURITY_POLICY } from "./response-headers-policy.ts";

describe("Edge", () => {
  it("refuses any region but us-east-1", () => {
    const stack = stackIn("eu-west-2");

    expect(
      () =>
        new Edge(stack, "Edge", {
          environment: "sandbox",
          domainName: DOMAIN_NAME,
          issuers: [],
          rateLimitPerFiveMinutes: 2000,
          logRetention: 90,
        }),
    ).toThrow("us-east-1");
  });

  it("has no unacknowledged cdk-nag finding", () => {
    const { app } = edgeTemplate({}, true);

    expect(() => app.synth()).not.toThrow();
  });

  it("answers at the name CloudFront gives it, with CloudFront's certificate, behind the web ACL", () => {
    const { edge, template } = edgeTemplate();

    template.resourceCountIs("AWS::Route53::HostedZone", 0);
    template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Enabled: true,
        HttpVersion: "http2and3",
        PriceClass: "PriceClass_100",
        WebACLId: { "Fn::GetAtt": [Match.stringLikeRegexp("WebAcl"), "Arn"] },
      }),
    });
    const [distribution] = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const config = (
      distribution?.Properties as {
        DistributionConfig: { Aliases?: unknown; ViewerCertificate?: unknown };
      }
    ).DistributionConfig;
    expect(config.Aliases).toBeUndefined();
    expect(config.ViewerCertificate).toBeUndefined();
    expect(edge.url).toMatch(/^https:\/\/\$\{Token/);
  });

  it("forwards to the API name only, over HTTPS, caching nothing, with an allowlist of headers", () => {
    const { template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Origins: [
          Match.objectLike({
            DomainName: `api.${DOMAIN_NAME}`,
            CustomOriginConfig: Match.objectLike({
              OriginProtocolPolicy: "https-only",
              OriginSSLProtocols: ["TLSv1.2"],
            }),
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
          CachePolicyId: { Ref: Match.stringLikeRegexp("NoCache") },
          OriginRequestPolicyId: {
            Ref: Match.stringLikeRegexp("OriginRequest"),
          },
        }),
      },
    });
    template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({
        MinTTL: 0,
        DefaultTTL: 0,
        MaxTTL: 0,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: {
            HeaderBehavior: "whitelist",
            Headers: ["Authorization"],
          },
        }),
      }),
    });
    template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: {
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: FORWARDED_HEADERS,
        },
        QueryStringsConfig: { QueryStringBehavior: "all" },
        CookiesConfig: { CookieBehavior: "none" },
      },
    });
    const [distribution] = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const config = (
      distribution?.Properties as {
        DistributionConfig: { Origins: unknown[]; CacheBehaviors?: unknown };
      }
    ).DistributionConfig;
    expect(config.Origins).toHaveLength(1);
    expect(config.CacheBehaviors).toBeUndefined();
  });

  it("runs the CloudFront Function on every viewer request, built with the environment's issuers", () => {
    const { template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Function", {
      AutoPublish: true,
      FunctionConfig: { Runtime: "cloudfront-js-2.0" },
      FunctionCode: Match.stringLikeRegexp("eu-west-2_example"),
    });
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

  it("sets the security headers on every response and keeps it out of caches", () => {
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
          Items: Match.arrayWith([
            { Header: "Cache-Control", Value: "no-store", Override: true },
          ]),
        },
      },
    });
  });

  it("writes access logs to a retained, locked bucket that expires them", () => {
    const { template } = edgeTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Logging: {
          Bucket: Match.anyValue(),
          IncludeCookies: false,
          Prefix: "cloudfront/",
        },
      },
    });
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        OwnershipControls: { Rules: [{ ObjectOwnership: "ObjectWriter" }] },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: "Enabled" },
        ObjectLockEnabled: true,
        LifecycleConfiguration: {
          Rules: [
            Match.objectLike({
              ExpirationInDays: 90,
              NoncurrentVersionExpiration: { NoncurrentDays: 90 },
            }),
          ],
        },
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: "s3:*",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });
});
