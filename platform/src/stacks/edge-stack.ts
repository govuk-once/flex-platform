import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

import {
  EDGE_ACCESS_LOG_RETENTION,
  EDGE_CONTENT_SECURITY_POLICY,
  EDGE_EXPORTS,
  EDGE_MINIMUM_TLS,
  EDGE_ORIGIN_PATH,
  EDGE_PRICE_CLASS,
  edgeDomainName,
  PARAMETERS,
  PLATFORM_REGION,
} from "../config.ts";
import { FlexEdge } from "../constructs/flex-edge.ts";
import type { Stage } from "../environment.ts";

export interface FlexEdgeStackProps {
  readonly stage: Stage;
  readonly account: string;
  readonly webAclArn: string;
  readonly certificate: ICertificate;
  readonly wafLogGroupName: string;
}

/**
 * The edge in the platform's region. What it needs of its account it reads from SSM parameters
 * at deploy time, so the configuration names no account, hostname or zone.
 */
export class FlexEdgeStack extends Stack {
  public readonly edge: FlexEdge;

  constructor(scope: Construct, id: string, props: FlexEdgeStackProps) {
    const { stage } = props;

    const stackProps: StackProps = {
      description: `Flex front door for the ${stage.name} stage: CloudFront, its logs and DNS`,
      env: { account: props.account, region: PLATFORM_REGION },
      terminationProtection: stage.persistent,
      crossRegionReferences: true,
    };
    super(scope, id, stackProps);

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: StringParameter.valueForStringParameter(
        this,
        PARAMETERS.hostedZoneId,
      ),
      zoneName: StringParameter.valueForStringParameter(
        this,
        PARAMETERS.hostedZoneName,
      ),
    });

    const originDomainName = StringParameter.valueForStringParameter(
      this,
      PARAMETERS.originDomainName(stage),
    );

    this.edge = new FlexEdge(this, "Edge", {
      name: `${stage.name}-flex-edge`,
      origin: { domainName: originDomainName, path: EDGE_ORIGIN_PATH },
      webAclArn: props.webAclArn,
      domain: {
        hostedZone,
        domainName: edgeDomainName(stage, hostedZone.zoneName),
        certificate: props.certificate,
      },
      logging: {
        accessLogRetention: EDGE_ACCESS_LOG_RETENTION,
        retainOnDelete: stage.persistent,
      },
      minimumProtocolVersion: EDGE_MINIMUM_TLS,
      priceClass: EDGE_PRICE_CLASS,
      contentSecurityPolicy: EDGE_CONTENT_SECURITY_POLICY,
    });

    const exports = {
      [EDGE_EXPORTS.distributionId(stage)]:
        this.edge.distribution.distributionId,
      [EDGE_EXPORTS.distributionDomainName(stage)]:
        this.edge.distribution.distributionDomainName,
      [EDGE_EXPORTS.url(stage)]: this.edge.url,
    };
    Object.entries(exports).forEach(([parameterName, stringValue], index) => {
      new StringParameter(this, `Export${String(index)}`, {
        parameterName,
        stringValue,
      });
    });

    new CfnOutput(this, "EdgeUrl", {
      description: "The URL callers use",
      value: this.edge.url,
    });
    new CfnOutput(this, "DistributionId", {
      value: this.edge.distribution.distributionId,
    });
    new CfnOutput(this, "DistributionDomainName", {
      value: this.edge.distribution.distributionDomainName,
    });
    new CfnOutput(this, "WafLogGroupName", {
      description:
        "The CloudWatch log group, in us-east-1, every request the web ACL evaluates is written to",
      value: props.wafLogGroupName,
    });
    new CfnOutput(this, "AccessLogBucketName", {
      description: "The S3 bucket CloudFront access logs are written to",
      value: this.edge.accessLogBucket.bucket.bucketName,
    });
  }
}
