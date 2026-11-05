import {
  ApiGatewayLogging,
  certificateParameterName,
  DOMAIN_REGION,
  WildcardCertificate,
} from "@repo/domain-infra";
import { Stack } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
} from "../config/types.ts";

// Not domain-, which a domain's stack starts with: names may hold hyphens, so only a different first
// word keeps an account's stack name from ever being a domain's.
export function domainAccountStackName(
  environment: EnvironmentConfig,
  domainAccount: DomainAccountConfig,
): string {
  return `domainaccount-${environment.name}-${domainAccount.name}`;
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

    new ApiGatewayLogging(this, "ApiGatewayLogging", {
      environment: environment.name,
    });
  }
}
