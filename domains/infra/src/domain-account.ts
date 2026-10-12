import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import {
  CfnAccount,
  DomainName,
  EndpointType,
  SecurityPolicy,
} from "aws-cdk-lib/aws-apigateway";
import type { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import {
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type {
  HostedZoneAttributes,
  IHostedZone,
} from "aws-cdk-lib/aws-route53";
import {
  ARecord,
  CaaAmazonRecord,
  HostedZone,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { ApiGatewayDomain } from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";

import type { EnvironmentNameOptions } from "./names.ts";
import {
  API_EXECUTION_LOG_GROUP_PATTERN,
  domainHostName,
  domainLogGroupPattern,
} from "./names.ts";

export interface DomainAccountProps {
  readonly environment: string;
  /** The account's own zone, already delegated to it. Each domain answers at `<domain>.<zone>`. */
  readonly zone: HostedZoneAttributes;
  /** The domains the account hosts in this environment, by name. */
  readonly domainNames: readonly string[];
}

interface HostOptions {
  readonly zone: IHostedZone;
  readonly certificate: ICertificate;
}

// What a domain account's domains share in one environment: the certificate for its zone, the
// host each domain answers at, and API Gateway's permission to write their logs.
//
// A domain's own stack maps its API to its host by name, so the host is built here, ahead of it,
// and the certificate never leaves this construct. Construct IDs under each host are the domain's
// name, so adding or removing a domain leaves every other host as it is.
export class DomainAccount extends Construct {
  constructor(scope: Construct, id: string, props: DomainAccountProps) {
    const { environment, zone: zoneAttributes, domainNames } = props;

    super(scope, id);

    const zone = HostedZone.fromHostedZoneAttributes(
      this,
      "Zone",
      zoneAttributes,
    );
    const certificate = this.buildCertificate(zone);

    for (const domainName of domainNames) {
      this.buildHost(domainName, { zone, certificate });
    }

    this.buildApiGatewayLogging({ environment });
  }

  // One wildcard for every domain: `<domain>.<zone>` would leave a domain name as few as 19
  // characters within ACM's 64.
  private buildCertificate(zone: IHostedZone): Certificate {
    // Only Amazon may issue for the zone. ACM checks CAA before it issues, so the record comes
    // first.
    const caa = new CaaAmazonRecord(this, "Caa", {
      zone,
      recordName: zone.zoneName,
    });

    // CloudFormation writes the validation record into the zone and waits for ACM to issue.
    const certificate = new Certificate(this, "Certificate", {
      domainName: `*.${zone.zoneName}`,
      validation: CertificateValidation.fromDns(zone),
    });

    certificate.node.addDependency(caa);

    return certificate;
  }

  private buildHost(
    domainName: string,
    { zone, certificate }: HostOptions,
  ): DomainName {
    const scope = new Construct(this, domainName);

    const hostName = domainHostName(domainName, { zoneName: zone.zoneName });

    const host = new DomainName(scope, "DomainName", {
      domainName: hostName,
      certificate,
      endpointType: EndpointType.REGIONAL,
      securityPolicy: SecurityPolicy.TLS_1_2,
    });

    new ARecord(scope, "Alias", {
      zone,
      recordName: hostName,
      target: RecordTarget.fromAlias(new ApiGatewayDomain(host)),
    });

    return host;
  }

  // API Gateway writes every API's logs in an account and region as one role, set on the account.
  // Each domain's stage logs to groups named under its environment, and to its execution log
  // group, so the role may write only to those.
  private buildApiGatewayLogging({
    environment,
  }: EnvironmentNameOptions): Role {
    const stack = Stack.of(this);

    const logGroupArn = (pattern: string) =>
      stack.formatArn({
        service: "logs",
        resource: "log-group",
        resourceName: `${pattern}:*`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      });

    const domainLogGroups = logGroupArn(domainLogGroupPattern({ environment }));
    const executionLogGroups = logGroupArn(API_EXECUTION_LOG_GROUP_PATTERN);
    const everyLogGroup = logGroupArn("*");

    const role = new Role(this, "ApiGatewayLogsRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
      inlinePolicies: {
        WriteLogs: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:DescribeLogStreams",
                "logs:PutLogEvents",
                "logs:GetLogEvents",
                "logs:FilterLogEvents",
              ],
              resources: [domainLogGroups, executionLogGroups],
            }),
            new PolicyStatement({
              actions: ["logs:DescribeLogGroups"],
              resources: [everyLogGroup],
            }),
          ],
        }),
      },
    });

    for (const resource of [
      domainLogGroups,
      executionLogGroups,
      everyLogGroup,
    ]) {
      Validations.of(role).acknowledge({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason:
          "API Gateway names each log stream, and an execution log group after its API's generated ID. Every group is named under the environment's prefix or API Gateway's own.",
      });
    }

    new CfnAccount(this, "ApiGatewayAccount", {
      cloudWatchRoleArn: role.roleArn,
    });

    return role;
  }
}
