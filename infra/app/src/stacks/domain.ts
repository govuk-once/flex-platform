import {
  ApiHost,
  certificateParameterName,
  DOMAIN_REGION,
  ProxyApi,
} from "@repo/domain-infra";
import { edgeRoleName } from "@repo/frontdoor-infra";
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

/** One domain's API and the host it answers at, in the domain account that hosts it. */
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
  }
}
