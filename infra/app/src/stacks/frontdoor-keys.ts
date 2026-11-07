import {
  CallerTokenKeysBucket,
  callerTokenKeysBucketName,
  KeyRotation,
  SigningKey,
} from "@repo/frontdoor-infra";
import { SIGNING_KEY_REGION } from "@repo/frontdoor-shared";
import { gatewayRoleName } from "@repo/gateway-infra";
import { NETWORK_REGION } from "@repo/infra-constructs";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { EnvironmentConfig } from "../config/types.ts";

export function frontdoorSigningKeyStackName(
  environment: EnvironmentConfig,
): string {
  return `frontdoor-${environment.name}-signing-key`;
}

export function frontdoorCallerTokenKeysStackName(
  environment: EnvironmentConfig,
): string {
  return `frontdoor-${environment.name}-caller-token-keys`;
}

export function frontdoorKeyRotationStackName(
  environment: EnvironmentConfig,
): string {
  return `frontdoor-${environment.name}-key-rotation`;
}

/**
 * The KMS key that wraps the private keys the edge signs the caller token with. Protected from
 * deletion, and its key retained: without it, the edge can't sign.
 */
export class FrontdoorSigningKeyStack extends Stack {
  constructor(scope: Construct, environment: EnvironmentConfig) {
    super(scope, frontdoorSigningKeyStackName(environment), {
      description: `Flex front door's caller token signing key for the ${environment.name} environment`,
      env: {
        account: environment.frontdoor.account,
        region: SIGNING_KEY_REGION,
      },
      terminationProtection: true,
    });

    new SigningKey(this, "SigningKey", { environment: environment.name });
  }
}

/**
 * The bucket every gateway reads the caller token's public keys from, in the gateways' region.
 * Protected from deletion, and its bucket retained: without it, no gateway can verify a token.
 */
export class FrontdoorCallerTokenKeysStack extends Stack {
  constructor(scope: Construct, environment: EnvironmentConfig) {
    super(scope, frontdoorCallerTokenKeysStackName(environment), {
      description: `Flex front door's caller token public keys for the ${environment.name} environment`,
      env: { account: environment.frontdoor.account, region: NETWORK_REGION },
      terminationProtection: true,
    });

    new CallerTokenKeysBucket(this, "CallerTokenKeys", {
      environment: environment.name,
      // Each gateway's role, in each domain account that runs it.
      readerRoles: environment.domainAccounts.flatMap(({ account, gateways }) =>
        gateways.map(
          ({ id }) =>
            `arn:aws:iam::${account}:role/${gatewayRoleName(environment.name, id)}`,
        ),
      ),
    });
  }
}

/**
 * Key rotation, which makes the caller token's keys under the signing key, gives the edge its
 * private keys, and writes every public key to the bucket the gateways read.
 */
export class FrontdoorKeyRotationStack extends Stack {
  constructor(scope: Construct, environment: EnvironmentConfig) {
    super(scope, frontdoorKeyRotationStackName(environment), {
      description: `Flex front door's caller token key rotation for the ${environment.name} environment`,
      env: {
        account: environment.frontdoor.account,
        region: SIGNING_KEY_REGION,
      },
    });

    new KeyRotation(this, "KeyRotation", {
      environment: environment.name,
      publicKeysBucket: callerTokenKeysBucketName(
        environment.name,
        environment.frontdoor.account,
      ),
      publicKeysAccount: environment.frontdoor.account,
      publicKeysRegion: NETWORK_REGION,
    });
  }
}
