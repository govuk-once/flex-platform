import { App, Duration, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { describe, expect, it } from "vitest";

import {
  FlexEdge,
  type FlexEdgeProps,
} from "../../src/constructs/flex-edge.ts";

const WEB_ACL_ARN =
  "arn:aws:wafv2:us-east-1:123456789012:global/webacl/test-flex-edge/0a1b2c3d";
const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/0a1b2c3d-0000-0000-0000-000000000000";

const LOGGING: FlexEdgeProps["logging"] = {
  accessLogRetention: Duration.days(90),
  retainOnDelete: true,
};

function build(
  overrides: Partial<FlexEdgeProps> = {},
  { region = "eu-west-2", withDomain = true } = {},
) {
  const app = new App();
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region },
  });
  const hostedZone = HostedZone.fromHostedZoneAttributes(stack, "Zone", {
    hostedZoneId: "Z0000000000000000000A",
    zoneName: "flex.example.gov.uk",
  });
  const certificate = Certificate.fromCertificateArn(
    stack,
    "Certificate",
    CERTIFICATE_ARN,
  );

  const edge = new FlexEdge(stack, "Edge", {
    name: "test-flex-edge",
    origin: {
      domainName: "abc123.execute-api.eu-west-2.amazonaws.com",
      path: "/prod",
    },
    webAclArn: WEB_ACL_ARN,
    ...(withDomain && {
      domain: {
        hostedZone,
        domainName: "api.flex.example.gov.uk",
        certificate,
      },
    }),
    logging: LOGGING,
    ...overrides,
  });

  return { edge, template: Template.fromStack(stack) };
}

describe("FlexEdge", () => {
  it("can be created in the platform's region, given what CloudFront keeps in us-east-1", () => {
    const { template } = build({}, { region: "eu-west-2" });

    template.resourceCountIs("AWS::WAFv2::WebACL", 0);
    template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        WebACLId: WEB_ACL_ARN,
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: CERTIFICATE_ARN,
        }),
      },
    });
  });

  it("forwards to the API layer only, over HTTPS, uncached, with the Host header left out", () => {
    const { template } = build();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Enabled: true,
        HttpVersion: "http2and3",
        PriceClass: "PriceClass_100",
        Origins: [
          Match.objectLike({
            DomainName: "abc123.execute-api.eu-west-2.amazonaws.com",
            OriginPath: "/prod",
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
          // CachingDisabled and AllViewerExceptHostHeader, which AWS manages.
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
          ResponseHeadersPolicyId: Match.anyValue(),
        }),
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

  it("serves the agreed name with the given certificate at or above TLS 1.2", () => {
    const { template } = build();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Aliases: ["api.flex.example.gov.uk"],
        ViewerCertificate: {
          AcmCertificateArn: CERTIFICATE_ARN,
          MinimumProtocolVersion: "TLSv1.2_2021",
          SslSupportMethod: "sni-only",
        },
      },
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "api.flex.example.gov.uk.",
      Type: "A",
      HostedZoneId: "Z0000000000000000000A",
      AliasTarget: Match.objectLike({
        DNSName: {
          "Fn::GetAtt": [Match.stringLikeRegexp("Distribution"), "DomainName"],
        },
      }),
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "api.flex.example.gov.uk.",
      Type: "AAAA",
    });
  });

  it("answers at its CloudFront name when no domain is given", () => {
    const { edge, template } = build({}, { withDomain: false });

    template.resourceCountIs("AWS::Route53::RecordSet", 0);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.not(
        Match.objectLike({ Aliases: Match.anyValue() }),
      ),
    });
    expect(edge.url).toContain("https://");
  });

  it("sets the security headers on every response and keeps it out of caches", () => {
    const { template } = build();

    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: {
        Name: "test-flex-edge-security-headers",
        SecurityHeadersConfig: {
          ContentSecurityPolicy: {
            ContentSecurityPolicy: "default-src 'self'",
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

  it("writes access logs to a locked down bucket in its own region that expires them", () => {
    const { template } = build();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Logging: {
          Bucket: Match.anyValue(),
          IncludeCookies: false,
          Prefix: "cloudfront/",
        },
      },
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      OwnershipControls: {
        Rules: [{ ObjectOwnership: "ObjectWriter" }],
      },
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

  it("empties and removes an ephemeral stage's log bucket with its stack", () => {
    const { template } = build({
      logging: { ...LOGGING, retainOnDelete: false },
    });

    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      Properties: Match.not(Match.objectLike({ ObjectLockEnabled: true })),
    });
    template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  });
});
