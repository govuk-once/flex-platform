import { PlatformLogGroup } from "@repo/infra-constructs/log-group";
import { Duration, Stack, Validations } from "aws-cdk-lib";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  FunctionEventType,
  HttpVersion,
  type IFunction,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  OriginSslPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  CfnDelivery,
  CfnDeliveryDestination,
  CfnDeliverySource,
  CfnResourcePolicy,
  type LogGroup,
} from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { accessLogsName, originDomainName } from "./names.ts";
import { EdgeResponseHeadersPolicy } from "./response-headers-policy.ts";
import { WebAcl } from "./web-acl.ts";

export interface EdgeProps {
  readonly environment: string;
  /** The environment's domain name; the API layer is `api.` under it. */
  readonly domainName: string;
  /** Runs on every viewer request, before anything else looks at it. */
  readonly viewerRequestFunction: IFunction;
}

/**
 * The CloudFront distribution every request enters through, with its web ACL and its logs. It
 * answers at the name CloudFront gives it, with CloudFront's own certificate, until the platform
 * has hosted zones: a certificate for a name of the platform's own, and the TLS floor that comes
 * with it, wait on that.
 *
 * CloudFront takes a web ACL from us-east-1 only, so the edge is built there.
 *
 * The edge does not stop a caller reaching the origin directly. That is a separate control:
 * Lambda@Edge signing each forwarded request, checked by IAM authorisation on the API.
 */
export class Edge extends Construct {
  public readonly webAcl: WebAcl;
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
        `The edge must be created in us-east-1, where CloudFront takes its web ACL from, not ${stack.region}`,
      );
    }

    this.webAcl = new WebAcl(this, "WebAcl", {
      environment: props.environment,
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
        // Everything the viewer sent goes to the origin; the function has already checked it.
        // CloudFront still drops Authorization from a GET or HEAD, since no cache policy names it.
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
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
      id: "AwsSolutions-CFR4",
      reason:
        "CloudFront's default certificate sets no TLS floor. A certificate for a name of the platform's own, with TLSv1.2_2021, follows once the platform has hosted zones.",
    });

    this.url = `https://${this.distribution.distributionDomainName}`;
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
