import {
  apexAliases,
  apexCertificate,
  ApiResponseHeadersPolicy,
  CloudFrontWebAcl,
  deliverAccessLogs,
  functionUrlOrigin,
} from "@repo/infra-constructs";
import { CI_TOKEN_HEADER } from "@repo/shared-viewer-request";
import { Stack, Validations } from "aws-cdk-lib";
import type { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  FunctionEventType,
  HttpVersion,
  type IFunction,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  PriceClass,
  SecurityPolicyProtocol,
  SSLMethod,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { HostedZone, type HostedZoneAttributes } from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

import {
  CI_ORIGIN_ACCESS_CONTROL_NAME,
  CI_ORIGIN_REQUEST_POLICY_NAME,
  MANAGEMENT_ACCESS_LOGS_NAME,
  MANAGEMENT_REGION,
  MANAGEMENT_RESPONSE_HEADERS_POLICY_NAME,
  MANAGEMENT_WEB_ACL_NAME,
} from "./names.ts";

/** Requests one pipeline token may make in five minutes before the edge turns it away. */
export const RATE_LIMIT_PER_TOKEN = 100;

/** Requests one address may make in five minutes. Runners share addresses, so it is above a token's. */
export const RATE_LIMIT_PER_IP = 500;

/** Substituted in sampled requests and redacted in logs, so a credential reaches neither. */
export const REDACTED_HEADERS: readonly string[] = [
  CI_TOKEN_HEADER,
  "authorization",
  "cookie",
];

/**
 * The viewer headers the pipeline API never sees. `host`: the function URL answers only to its
 * own. Every other header a viewer sends is forwarded, because CloudFront signs the body's hash
 * the caller sends in `x-amz-content-sha256`, and refuses that header in a list of headers to
 * forward. No cookies, no query strings, and none of CloudFront's viewer IP and location headers.
 */
export const WITHHELD_HEADERS = ["host"] as const;

/** A header Lambda adds that names its internals. CloudFront refuses to remove `x-amzn-requestid`. */
export const REMOVED_HEADERS = ["x-amzn-trace-id"] as const;

export interface ManagementEdgeProps {
  /**
   * The shared account's own zone, already delegated to it. The distribution answers at its
   * apex, and writes its records there.
   */
  readonly zone: HostedZoneAttributes;
  /** Runs on every viewer request, before anything else looks at it. */
  readonly viewerRequestFunction: IFunction;
  /** The host of the pipeline API's function URL. */
  readonly ciOriginHost: string;
}

/**
 * The CloudFront distribution a stage is managed through, at the apex of the shared account's
 * zone, with its certificate, web ACL and logs. CloudFront takes a web ACL and a certificate from
 * us-east-1 only, so it is built there.
 *
 * Every path goes to the pipeline API's function URL, the one origin there is. The CloudFront
 * Function refuses any path that isn't the API's before it gets there.
 */
export class ManagementEdge extends Construct {
  public readonly webAcl: CloudFrontWebAcl;
  public readonly certificate: Certificate;
  /** Where CloudFront delivers its standard access logs. */
  public readonly accessLogGroup: LogGroup;
  public readonly distribution: Distribution;
  /** The address a pipeline calls. */
  public readonly url: string;

  constructor(scope: Construct, id: string, props: ManagementEdgeProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== MANAGEMENT_REGION) {
      throw new Error(
        `The management distribution must be created in ${MANAGEMENT_REGION}, where CloudFront takes its web ACL and certificate from, not ${stack.region}`,
      );
    }

    // The zone isn't ours to create, so it is named, not looked up: synth reads nothing from an
    // account.
    const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", props.zone);
    const domainName = props.zone.zoneName;

    // Only Amazon may issue for the zone.
    this.certificate = apexCertificate(this, zone, domainName);

    // The per-token limit counts the token header's exact value, so the CloudFront Function
    // accepts each token in one form only.
    this.webAcl = new CloudFrontWebAcl(this, "WebAcl", {
      name: MANAGEMENT_WEB_ACL_NAME,
      tokenHeader: CI_TOKEN_HEADER,
      rateLimitPerToken: RATE_LIMIT_PER_TOKEN,
      rateLimitPerIp: RATE_LIMIT_PER_IP,
      redactedHeaders: REDACTED_HEADERS,
    });

    this.distribution = new Distribution(this, "Distribution", {
      comment: "Flex management",
      domainNames: [domainName],
      certificate: this.certificate,
      // TLS 1.2 or 1.3 with AES-GCM ciphers only.
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2025,
      sslSupportMethod: SSLMethod.SNI,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
      webAclId: this.webAcl.webAcl.attrArn,
      defaultBehavior: {
        origin: functionUrlOrigin(this, "CiOriginAccessControl", {
          host: props.ciOriginHost,
          originId: "ci",
          originAccessControlName: CI_ORIGIN_ACCESS_CONTROL_NAME,
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: new OriginRequestPolicy(this, "CiOriginRequest", {
          originRequestPolicyName: CI_ORIGIN_REQUEST_POLICY_NAME,
          headerBehavior: OriginRequestHeaderBehavior.denyList(
            ...WITHHELD_HEADERS,
          ),
          queryStringBehavior: OriginRequestQueryStringBehavior.none(),
          cookieBehavior: OriginRequestCookieBehavior.none(),
        }),
        responseHeadersPolicy: new ApiResponseHeadersPolicy(
          this,
          "ResponseHeaders",
          {
            name: MANAGEMENT_RESPONSE_HEADERS_POLICY_NAME,
            removeHeaders: REMOVED_HEADERS,
          },
        ).policy,
        functionAssociations: [
          {
            function: props.viewerRequestFunction,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      publishAdditionalMetrics: true,
    });
    this.accessLogGroup = deliverAccessLogs(this, {
      name: MANAGEMENT_ACCESS_LOGS_NAME,
      distribution: this.distribution,
    });
    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR3",
      reason:
        "Access logs are delivered to CloudWatch Logs by standard logging v2, which the rule does not recognise; it looks for the legacy S3 logging block.",
    });
    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR1",
      reason:
        "No geographic restriction has been agreed: a pipeline's runner may be anywhere.",
    });
    apexAliases(this, zone, domainName, this.distribution);

    this.url = `https://${domainName}`;
  }
}
