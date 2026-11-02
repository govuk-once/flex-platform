import {
  ApiGatewayLogging,
  certificateParameterName,
  DOMAIN_REGION,
  ExecutionRole,
  functionLogGroupName,
  WildcardCertificate,
} from "@repo/domain-infra";
import { gatewayFunctionPattern } from "@repo/gateway-infra";
import { PlatformLogGroup } from "@repo/infra-constructs";
import { Stack } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
} from "../config/types.ts";

export function domainAccountStackName(
  environment: EnvironmentConfig,
  domainAccount: DomainAccountConfig,
): string {
  return `domain-${environment.name}-${domainAccount.name}`;
}

interface DomainAccountStackProps {
  readonly environment: EnvironmentConfig;
  readonly domainAccount: DomainAccountConfig;
}

/**
 * What every domain in a domain account shares in one environment. Nothing in it names a domain,
 * so adding or removing one never changes it.
 */
export class DomainAccountStack extends Stack {
  constructor(
    scope: Construct,
    { environment, domainAccount }: DomainAccountStackProps,
  ) {
    super(scope, domainAccountStackName(environment, domainAccount), {
      description: `Flex domain hosting shared by the ${domainAccount.name} domain account in the ${environment.name} environment`,
      env: { account: domainAccount.account, region: DOMAIN_REGION },
      // Deleting it would take the domains' execution role and certificate with it, and leave the
      // account's API Gateway logging setting naming a deleted role.
      terminationProtection: true,
    });

    const { certificate } = new WildcardCertificate(this, "Zone", {
      zone: {
        zoneName: domainAccount.zone.name,
        hostedZoneId: domainAccount.zone.id,
      },
    });

    new StringParameter(this, "CertificateArn", {
      parameterName: certificateParameterName(environment.name),
      stringValue: certificate.certificateArn,
    });

    const { key } = new PlatformLogGroup(this, "FunctionLogs", {
      logGroupName: functionLogGroupName(environment.name),
    });

    new ExecutionRole(this, "Execution", {
      environment: environment.name,
      gatewayFunctions: gatewayFunctionPattern(environment.name),
      logGroupKey: key,
    });

    new ApiGatewayLogging(this, "ApiGatewayLogging", {
      environment: environment.name,
    });
  }
}
