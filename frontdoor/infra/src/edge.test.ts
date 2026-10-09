import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { DOMAIN_NAME, edgeIn, edgeTemplate, stackIn } from "../test/helpers.ts";
import { CONTENT_SECURITY_POLICY } from "./response-headers-policy.ts";

describe("Edge", () => {
  it("refuses any region but us-east-1", () => {
    expect(() => edgeIn(stackIn("eu-west-2"))).toThrow("us-east-1");
  });

  it("has no unacknowledged cdk-nag finding", () => {
    const { app } = edgeTemplate(true);

    expect(() => app.synth()).not.toThrow();
  });

  it("answers at the name CloudFront gives it, with CloudFront's certificate, behind the web ACL", () => {
    const { edge, template } = edgeTemplate();

    template.resourceCountIs("AWS::Route53::HostedZone", 0);
    template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
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

  it("forwards everything the viewer sent to the API name only, over HTTPS, caching nothing", () => {
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
          // CachingDisabled and AllViewerExceptHostHeader, which AWS manages.
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
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

  it("delivers access logs to a retained log group through standard logging v2", () => {
    const { edge, template } = edgeTemplate();

    template.resourceCountIs("AWS::S3::Bucket", 0);
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
