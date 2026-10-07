import { Duration } from "aws-cdk-lib";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  OriginSslPolicy,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  AaaaRecord,
  ARecord,
  type IHostedZone,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { EdgeAccessLogBucket } from "./edge-access-log-bucket.ts";
import { EdgeResponseHeadersPolicy } from "./edge-response-headers-policy.ts";

export interface EdgeOrigin {
  readonly domainName: string;
  readonly path?: string;
}

export interface EdgeDomain {
  readonly hostedZone: IHostedZone;
  readonly domainName: string;
  /** Must be in us-east-1, where CloudFront requires a viewer certificate. */
  readonly certificate: ICertificate;
}

export interface EdgeLogging {
  readonly accessLogRetention: Duration;
  readonly retainOnDelete: boolean;
}

export interface FlexEdgeProps {
  readonly name: string;
  readonly origin: EdgeOrigin;
  /** Taken as an ARN, so the web ACL may be in another stack and region. */
  readonly webAclArn: string;
  /** Without one the distribution answers at its `cloudfront.net` name. */
  readonly domain?: EdgeDomain;
  readonly logging: EdgeLogging;
  readonly minimumProtocolVersion?: SecurityPolicyProtocol;
  readonly priceClass?: PriceClass;
  readonly contentSecurityPolicy?: string;
}

/**
 * A distribution is a global resource, so this can be created in any region once given the web
 * ACL and the certificate, the two parts CloudFront requires in us-east-1.
 *
 * It does not stop a caller reaching the origin directly: that is a separate control, request
 * signing at the edge checked by IAM authorisation on the API.
 */
export class FlexEdge extends Construct {
  public readonly distribution: Distribution;
  public readonly accessLogBucket: EdgeAccessLogBucket;
  public readonly url: string;

  constructor(scope: Construct, id: string, props: FlexEdgeProps) {
    super(scope, id);

    this.accessLogBucket = new EdgeAccessLogBucket(this, "AccessLogs", {
      retention: props.logging.accessLogRetention,
      retainOnDelete: props.logging.retainOnDelete,
    });

    const responseHeadersPolicy = new EdgeResponseHeadersPolicy(
      this,
      "ResponseHeaders",
      {
        policyName: `${props.name}-security-headers`,
        contentSecurityPolicy:
          props.contentSecurityPolicy ?? "default-src 'self'",
      },
    );

    this.distribution = new Distribution(this, "Distribution", {
      comment: `${props.name}: the Flex front door`,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: props.priceClass ?? PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion:
        props.minimumProtocolVersion ?? SecurityPolicyProtocol.TLS_V1_2_2021,
      webAclId: props.webAclArn,
      defaultBehavior: {
        origin: new HttpOrigin(props.origin.domainName, {
          protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
          originSslProtocols: [OriginSslPolicy.TLS_V1_2],
          readTimeout: Duration.seconds(30),
          ...(props.origin.path !== undefined && {
            originPath: props.origin.path,
          }),
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: responseHeadersPolicy.policy,
      },
      enableLogging: true,
      // Bucket's optional members are declared `| undefined` and IBucket's are not, which
      // exactOptionalPropertyTypes tells apart.
      logBucket: this.accessLogBucket.bucket as IBucket,
      logFilePrefix: "cloudfront/",
      logIncludesCookies: false,
      publishAdditionalMetrics: true,
      ...(props.domain && {
        domainNames: [props.domain.domainName],
        certificate: props.domain.certificate,
      }),
    });

    if (props.domain) {
      const target = RecordTarget.fromAlias(
        new CloudFrontTarget(this.distribution),
      );
      new ARecord(this, "AliasA", {
        zone: props.domain.hostedZone,
        recordName: props.domain.domainName,
        target,
      });
      new AaaaRecord(this, "AliasAAAA", {
        zone: props.domain.hostedZone,
        recordName: props.domain.domainName,
        target,
      });
    }

    this.url = `https://${props.domain?.domainName ?? this.distribution.distributionDomainName}`;
  }
}
