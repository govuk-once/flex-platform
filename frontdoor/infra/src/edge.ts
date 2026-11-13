import {
  apexAliases,
  apexCertificate,
  ApiResponseHeadersPolicy,
  CloudFrontWebAcl,
  deliverAccessLogs,
  PlatformBucket,
} from "@repo/infra-constructs";
import { RemovalPolicy, Stack, Validations } from "aws-cdk-lib";
import type { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  FunctionEventType,
  HttpVersion,
  type IFunction,
  LambdaEdgeEventType,
  PriceClass,
  SecurityPolicyProtocol,
  SSLMethod,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { IVersion, Version } from "aws-cdk-lib/aws-lambda";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { HostedZone, type HostedZoneAttributes } from "aws-cdk-lib/aws-route53";
import type { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import {
  accessLogsName,
  responseHeadersPolicyName,
  webAclName,
} from "./names.ts";
import { EdgeOriginRequestPolicy } from "./origin-request-policy.ts";

/** Requests one bearer token may make in five minutes before the edge turns it away. */
export const RATE_LIMIT_PER_TOKEN = 1000;

/** Requests one address may make in five minutes, above the per-token limit for shared networks. */
export const RATE_LIMIT_PER_IP = 5000;

/** Substituted in sampled requests and redacted in logs, so a credential reaches neither. */
export const REDACTED_HEADERS: readonly string[] = ["authorization", "cookie"];

/**
 * Headers API Gateway adds that name its internals: `x-amzn-remapped-*` is the documented set,
 * since CloudFront takes exact names only. CloudFront refuses to remove `x-amzn-requestid`.
 */
export const REMOVED_HEADERS = [
  "x-amz-apigw-id",
  "x-amzn-trace-id",
  "x-amzn-remapped-authorization",
  "x-amzn-remapped-connection",
  "x-amzn-remapped-content-md5",
  "x-amzn-remapped-date",
  "x-amzn-remapped-max-forwards",
  "x-amzn-remapped-server",
  "x-amzn-remapped-user-agent",
  "x-amzn-remapped-www-authenticate",
] as const;

export interface EdgeProps {
  readonly environment: string;
  /**
   * The frontdoor account's own zone, already delegated to it. The edge answers at its apex, and
   * writes its records there.
   */
  readonly zone: HostedZoneAttributes;
  /** Runs on every viewer request, before anything else looks at it. */
  readonly viewerRequestFunction: IFunction;
  /** Runs on every request the viewer request function lets through, before the origin. */
  readonly originRequestFunction: Version;
}

/**
 * The CloudFront distribution every request enters through, at the apex of the frontdoor
 * account's zone, with its certificate, web ACL and logs. CloudFront takes a web ACL and a
 * certificate from us-east-1 only, so the edge is built there.
 */
export class Edge extends Construct {
  public readonly webAcl: CloudFrontWebAcl;
  public readonly certificate: Certificate;
  /** The default origin, which is empty and serves nothing. */
  public readonly defaultOrigin: Bucket;
  /** Where CloudFront delivers its standard access logs. */
  public readonly accessLogGroup: LogGroup;
  public readonly distribution: Distribution;
  /** The URL the app calls. */
  public readonly url: string;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== "us-east-1") {
      throw new Error(
        `The edge must be created in us-east-1, where CloudFront takes its web ACL and certificate from, not ${stack.region}`,
      );
    }

    // The zone isn't ours to create, so it is named, not looked up: synth reads nothing from an
    // account.
    const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", props.zone);
    const domainName = props.zone.zoneName;

    // Only Amazon may issue for the zone.
    this.certificate = apexCertificate(this, zone, domainName);

    // The per-token limit counts the `Authorization` header's exact value, so both of the edge's
    // functions accept each token in one form only: `Bearer`, one space, and the token in its
    // canonical base64url.
    this.webAcl = new CloudFrontWebAcl(this, "WebAcl", {
      name: webAclName(props.environment),
      tokenHeader: "authorization",
      rateLimitPerToken: RATE_LIMIT_PER_TOKEN,
      rateLimitPerIp: RATE_LIMIT_PER_IP,
      redactedHeaders: REDACTED_HEADERS,
    });

    this.defaultOrigin = this.createDefaultOrigin();

    this.distribution = new Distribution(this, "Distribution", {
      comment: `Flex front door, ${props.environment}`,
      domainNames: [domainName],
      certificate: this.certificate,
      // TLS 1.2 or 1.3 with AES-GCM ciphers only. TLS 1.3 alone would rule out older phones.
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2025,
      sslSupportMethod: SSLMethod.SNI,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
      webAclId: this.webAcl.webAcl.attrArn,
      defaultBehavior: {
        // CDK declares Bucket's `isWebsite` as possibly undefined and IBucket's as optional, which
        // `exactOptionalPropertyTypes` won't match.
        // Named, since CDK's default ID is built from the stack's name.
        origin: S3BucketOrigin.withBucketDefaults(
          this.defaultOrigin as IBucket,
          { originId: "default" },
        ),
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: new EdgeOriginRequestPolicy(
          this,
          "OriginRequest",
          {
            environment: props.environment,
          },
        ).policy,
        // The security headers on every response, which no domain can weaken.
        responseHeadersPolicy: new ApiResponseHeadersPolicy(
          this,
          "ResponseHeaders",
          {
            name: responseHeadersPolicyName(props.environment),
            removeHeaders: REMOVED_HEADERS,
          },
        ).policy,
        functionAssociations: [
          {
            function: props.viewerRequestFunction,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
        edgeLambdas: [
          {
            // CDK declares Version's `role` as possibly undefined and IVersion's as optional,
            // which `exactOptionalPropertyTypes` won't match.
            functionVersion: props.originRequestFunction as IVersion,
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            // The body is hashed into the signature. WAF refuses one over 16 KB, well inside the
            // 1 MB Lambda@Edge sees at origin request.
            includeBody: true,
          },
        ],
      },
      publishAdditionalMetrics: true,
    });
    this.accessLogGroup = deliverAccessLogs(this, {
      name: accessLogsName(props.environment),
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
        "No geographic restriction has been agreed: the app is used by people abroad.",
    });
    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR7",
      reason:
        "The S3 origin is an empty bucket that resolves for Lambda@Edge, and must refuse every request: origin access control would let CloudFront read it, and would replace the caller's Authorization header with a signature.",
    });
    apexAliases(this, zone, domainName, this.distribution);

    this.url = `https://${domainName}`;
  }

  // CloudFront resolves the origin's name before Lambda@Edge runs, and answers 502 if it can't, so
  // the default origin must be a name that resolves, and ours. Nothing signs requests to it (no
  // origin access control), so a request that reaches it gets S3's refusal, with the caller's
  // token never replaced by a signature.
  private createDefaultOrigin(): Bucket {
    const { bucket } = new PlatformBucket(this, "DefaultOrigin", {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Validations.of(bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "The bucket is empty and refuses every request, so its access logs would hold nothing CloudFront's don't.",
    });
    return bucket;
  }
}
