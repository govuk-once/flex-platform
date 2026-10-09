import {
  buildViewerRequestFunction,
  type TrustedIssuer,
} from "@repo/frontdoor-cloudfront-function";
import { Duration, Stack, Validations } from "aws-cdk-lib";
import {
  AllowedMethods,
  CacheHeaderBehavior,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  OriginSslPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { AccessLogBucket } from "./access-log-bucket.ts";
import { originDomainName } from "./names.ts";
import { EdgeResponseHeadersPolicy } from "./response-headers-policy.ts";
import type { ManagedRuleGroup } from "./waf-rules.ts";
import { WebAcl } from "./web-acl.ts";

/**
 * The headers forwarded to the origin, and no others: a caller's `Host` and hop-by-hop headers
 * stay at the edge. CloudFront drops `Authorization` unless the cache policy names it, which is
 * why it is not in this list but in the cache policy below, which caches nothing.
 */
export const FORWARDED_HEADERS: readonly string[] = [
  "Accept",
  "Accept-Language",
  "Content-Type",
  "X-Correlation-Id",
];

export interface EdgeProps {
  readonly environment: string;
  /** The environment's domain name; the API layer is `api.` under it. */
  readonly domainName: string;
  /** The user pools and app clients whose tokens the CloudFront Function lets through. */
  readonly issuers: readonly TrustedIssuer[];
  readonly rateLimitPerFiveMinutes: number;
  readonly logRetention: RetentionDays;
  readonly managedRuleGroups?: readonly ManagedRuleGroup[];
}

/**
 * The CloudFront distribution every request enters through, with its web ACL, its CloudFront
 * Function and its logs. It answers at the name CloudFront gives it, with CloudFront's own
 * certificate, until the platform has hosted zones: a certificate for a name of the platform's
 * own, and the TLS floor that comes with it, wait on that.
 *
 * CloudFront takes a web ACL from us-east-1 only, so the edge is built there.
 *
 * The edge does not stop a caller reaching the origin directly. That is a separate control:
 * Lambda@Edge signing each forwarded request, checked by IAM authorisation on the API.
 */
export class Edge extends Construct {
  public readonly webAcl: WebAcl;
  public readonly accessLogBucket: AccessLogBucket;
  public readonly viewerRequestFunction: CloudFrontFunction;
  public readonly distribution: Distribution;
  /** The URL the app calls. */
  public readonly url: string;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== "us-east-1") {
      throw new Error(
        `The edge must be created in us-east-1, where CloudFront takes its web ACL from, not ${stack.region}`,
      );
    }

    this.webAcl = new WebAcl(this, "WebAcl", {
      environment: props.environment,
      rateLimitPerFiveMinutes: props.rateLimitPerFiveMinutes,
      logRetention: props.logRetention,
      ...(props.managedRuleGroups && {
        managedRuleGroups: props.managedRuleGroups,
      }),
    });

    this.accessLogBucket = new AccessLogBucket(this, "AccessLogs", {
      retention: Duration.days(props.logRetention),
    });

    this.viewerRequestFunction = new CloudFrontFunction(this, "ViewerRequest", {
      code: FunctionCode.fromInline(
        buildViewerRequestFunction({ issuers: props.issuers }),
      ),
      runtime: FunctionRuntime.JS_2_0,
    });

    // Caches nothing. A cache policy is the only policy CloudFront lets Authorization through.
    const cachePolicy = new CachePolicy(this, "NoCache", {
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(0),
      headerBehavior: CacheHeaderBehavior.allowList("Authorization"),
    });

    const originRequestPolicy = new OriginRequestPolicy(this, "OriginRequest", {
      headerBehavior: OriginRequestHeaderBehavior.allowList(
        ...FORWARDED_HEADERS,
      ),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
      cookieBehavior: OriginRequestCookieBehavior.none(),
    });

    this.distribution = new Distribution(this, "Distribution", {
      comment: `Flex front door, ${props.environment}`,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
      webAclId: this.webAcl.webAcl.attrArn,
      defaultBehavior: {
        origin: new HttpOrigin(originDomainName(props.domainName), {
          protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
          originSslProtocols: [OriginSslPolicy.TLS_V1_2],
          readTimeout: Duration.seconds(30),
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy,
        originRequestPolicy,
        responseHeadersPolicy: new EdgeResponseHeadersPolicy(
          this,
          "ResponseHeaders",
        ).policy,
        functionAssociations: [
          {
            function: this.viewerRequestFunction,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      enableLogging: true,
      // Bucket's optional members are declared `| undefined` and IBucket's are not, which
      // exactOptionalPropertyTypes tells apart.
      logBucket: this.accessLogBucket.bucket as IBucket,
      logFilePrefix: "cloudfront/",
      logIncludesCookies: false,
      publishAdditionalMetrics: true,
    });
    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR1",
      reason:
        "No geographic restriction has been agreed: the app is used by people abroad.",
    });
    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR4",
      reason:
        "CloudFront's default certificate sets no TLS floor. A certificate for a name of the platform's own, with TLSv1.2_2021, follows once the platform has hosted zones.",
    });

    this.url = `https://${this.distribution.distributionDomainName}`;
  }
}
