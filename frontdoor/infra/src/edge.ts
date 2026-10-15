import { PlatformBucket, PlatformLogGroup } from "@repo/infra-constructs";
import { RemovalPolicy, Stack, Validations } from "aws-cdk-lib";
import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
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
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { IVersion, Version } from "aws-cdk-lib/aws-lambda";
import {
  CfnDelivery,
  CfnDeliveryDestination,
  CfnDeliverySource,
  CfnResourcePolicy,
  type LogGroup,
} from "aws-cdk-lib/aws-logs";
import {
  AaaaRecord,
  ARecord,
  CaaAmazonRecord,
  HostedZone,
  type HostedZoneAttributes,
  type IHostedZone,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import type { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { accessLogsName } from "./names.ts";
import { EdgeOriginRequestPolicy } from "./origin-request-policy.ts";
import { EdgeResponseHeadersPolicy } from "./response-headers-policy.ts";
import { WebAcl } from "./web-acl.ts";

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
  public readonly webAcl: WebAcl;
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

    // Only Amazon may issue for the zone. ACM checks CAA before it issues, so the record comes
    // first.
    const caa = new CaaAmazonRecord(this, "Caa", {
      zone,
      recordName: domainName,
    });

    // CloudFormation writes the validation record into the zone and waits for ACM to issue.
    this.certificate = new Certificate(this, "Certificate", {
      domainName,
      validation: CertificateValidation.fromDns(zone),
    });
    this.certificate.node.addDependency(caa);

    this.webAcl = new WebAcl(this, "WebAcl", {
      environment: props.environment,
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
        origin: S3BucketOrigin.withBucketDefaults(
          this.defaultOrigin as IBucket,
        ),
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: new EdgeOriginRequestPolicy(this, "OriginRequest")
          .policy,
        responseHeadersPolicy: new EdgeResponseHeadersPolicy(
          this,
          "ResponseHeaders",
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
    this.accessLogGroup = this.deliverAccessLogs(props.environment);
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
    this.createAliases(zone, domainName);

    this.url = `https://${domainName}`;
  }

  // An alias at the apex for IPv4 and IPv6, since the distribution answers on both.
  private createAliases(zone: IHostedZone, recordName: string): void {
    const target = RecordTarget.fromAlias(
      new CloudFrontTarget(this.distribution),
    );
    new ARecord(this, "AliasIpv4", { zone, recordName, target });
    new AaaaRecord(this, "AliasIpv6", { zone, recordName, target });
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

  // Standard logging v2: CloudWatch Logs delivers the distribution's access logs to a log group,
  // which log forwarding will carry on to the shared account. CloudFront's delivery source must
  // be in us-east-1, as the web ACL must.
  private deliverAccessLogs(environment: string): LogGroup {
    const stack = Stack.of(this);
    const name = accessLogsName(environment);
    const { logGroup } = new PlatformLogGroup(this, "AccessLogs");

    const source = new CfnDeliverySource(this, "AccessLogSource", {
      name,
      logType: "ACCESS_LOGS",
      resourceArn: this.distribution.distributionArn,
    });

    // The delivery service writes to the log group under its own principal, which the account
    // has to allow; the conditions tie the grant to this one source.
    const policy = new CfnResourcePolicy(this, "AccessLogPolicy", {
      policyName: name,
      policyDocument: stack.toJsonString({
        Version: "2012-10-17",
        Statement: [
          new PolicyStatement({
            sid: "AllowLogDelivery",
            effect: Effect.ALLOW,
            principals: [new ServicePrincipal("delivery.logs.amazonaws.com")],
            actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
            resources: [logGroup.logGroupArn],
            conditions: {
              StringEquals: { "aws:SourceAccount": stack.account },
              ArnLike: {
                "aws:SourceArn": stack.formatArn({
                  service: "logs",
                  resource: "delivery-source",
                  resourceName: name,
                }),
              },
            },
          }).toStatementJson(),
        ],
      }),
    });

    const destination = new CfnDeliveryDestination(
      this,
      "AccessLogDestination",
      {
        name,
        deliveryDestinationType: "CWL",
        destinationResourceArn: logGroup.logGroupArn,
      },
    );

    const delivery = new CfnDelivery(this, "AccessLogDelivery", {
      deliverySourceName: source.name,
      deliveryDestinationArn: destination.attrArn,
    });
    delivery.addResourceDependency(source);
    delivery.addResourceDependency(policy);

    return logGroup;
  }
}
