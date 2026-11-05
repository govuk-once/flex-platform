import {
  ApiHost,
  certificateParameterName,
  DeployRole,
  DOMAIN_REGION,
  ExecutionRole,
  functionLogGroupName,
  ProxyApi,
} from "@repo/domain-infra";
import { edgeRoleName } from "@repo/frontdoor-infra";
import { gatewayFunctionPattern } from "@repo/gateway-infra";
import {
  PlatformLogGroup,
  securityGroupIdParameterName,
  subnetIdsParameterName,
} from "@repo/infra-constructs";
import { Stack } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
} from "../config/types.ts";

export function domainStackName(
  environment: EnvironmentConfig,
  domain: string,
): string {
  return `domain-${environment.name}-${domain}`;
}

interface DomainStackProps {
  readonly environment: EnvironmentConfig;
  readonly domainAccount: DomainAccountConfig;
  readonly domain: string;
}

/**
 * One domain's API and the host it answers at, and the log group and roles its function runs and
 * is released with, in the domain account that hosts it.
 */
export class DomainStack extends Stack {
  constructor(
    scope: Construct,
    { environment, domainAccount, domain }: DomainStackProps,
  ) {
    super(scope, domainStackName(environment, domain), {
      description: `Flex domain ${domain} in the ${environment.name} environment`,
      env: { account: domainAccount.account, region: DOMAIN_REGION },
    });

    const { api } = new ProxyApi(this, "Domain", {
      environment: environment.name,
      domain,
      edgeRole: {
        account: environment.frontdoor.account,
        name: edgeRoleName(environment.name),
      },
    });

    new ApiHost(this, "Host", {
      domain,
      zone: {
        zoneName: domainAccount.zone.name,
        hostedZoneId: domainAccount.zone.id,
      },
      certificateArn: StringParameter.valueForStringParameter(
        this,
        certificateParameterName(environment.name),
      ),
      api,
    });

    const { key } = new PlatformLogGroup(this, "FunctionLogs", {
      logGroupName: functionLogGroupName(environment.name, domain),
    });

    const gatewayFunctions = gatewayFunctionPattern(environment.name);

    new ExecutionRole(this, "Execution", {
      environment: environment.name,
      domain,
      gatewayFunctions,
      logGroupKey: key,
    });

    new DeployRole(this, "Deploy", {
      environment: environment.name,
      domain,
      gatewayFunctions,
      subnetIdsParameterName: subnetIdsParameterName(
        environment.name,
        "isolated",
      ),
      securityGroupIdParameterName: securityGroupIdParameterName(
        environment.name,
        "domain",
      ),
    });
  }
}
