import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";

import {
  CLOUDFRONT_GLOBAL_REGION,
  EDGE_RATE_LIMIT_PER_FIVE_MINUTES,
  EDGE_RATE_LIMIT_RESPONSE_CODE,
  EDGE_WAF_LOG_RETENTION,
  edgeDomainName,
  PARAMETERS,
  PLATFORM_REGION,
} from "../config.ts";
import { CrossRegionParameter } from "../constructs/cross-region-parameter.ts";
import { EdgeWebAcl } from "../constructs/edge-web-acl.ts";
import type { Stage } from "../environment.ts";

export interface FlexEdgeGlobalStackProps {
  readonly stage: Stage;
  readonly account: string;
}

/**
 * Only what CloudFront will take from us-east-1 alone: the web ACL, its log group and the viewer
 * certificate.
 */
export class FlexEdgeGlobalStack extends Stack {
  public readonly webAcl: EdgeWebAcl;
  public readonly certificate: Certificate;

  constructor(scope: Construct, id: string, props: FlexEdgeGlobalStackProps) {
    const { stage } = props;

    const stackProps: StackProps = {
      description: `Flex front door for the ${stage.name} stage: what CloudFront requires in us-east-1`,
      env: { account: props.account, region: CLOUDFRONT_GLOBAL_REGION },
      terminationProtection: stage.persistent,
      crossRegionReferences: true,
    };
    super(scope, id, stackProps);

    this.webAcl = new EdgeWebAcl(this, "WebAcl", {
      name: `${stage.name}-flex-edge`,
      rateLimit: {
        requestsPerWindow: EDGE_RATE_LIMIT_PER_FIVE_MINUTES,
        windowSeconds: 300,
        responseCode: EDGE_RATE_LIMIT_RESPONSE_CODE,
      },
      logRetention: EDGE_WAF_LOG_RETENTION,
      retainLogsOnDelete: stage.persistent,
    });

    const readerLogs = new LogGroup(this, "ReaderLogs", {
      encryptionKey: this.webAcl.logKey,
      retention: EDGE_WAF_LOG_RETENTION,
      removalPolicy: stage.persistent
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    });
    const readParameter = (id: string, parameterName: string) =>
      new CrossRegionParameter(this, id, {
        parameterName,
        region: PLATFORM_REGION,
        logGroup: readerLogs,
      }).stringValue;

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: readParameter("ZoneId", PARAMETERS.hostedZoneId),
      zoneName: readParameter("ZoneName", PARAMETERS.hostedZoneName),
    });

    this.certificate = new Certificate(this, "Certificate", {
      domainName: edgeDomainName(stage, hostedZone.zoneName),
      validation: CertificateValidation.fromDns(hostedZone),
    });

    new CfnOutput(this, "WebAclArn", { value: this.webAcl.webAcl.attrArn });
    new CfnOutput(this, "WafLogGroupName", {
      description:
        "The CloudWatch log group, in us-east-1, every request the web ACL evaluates is written to",
      value: this.webAcl.logGroupName,
    });
    new CfnOutput(this, "CertificateArn", {
      value: this.certificate.certificateArn,
    });
  }
}
