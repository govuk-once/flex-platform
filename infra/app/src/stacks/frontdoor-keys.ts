import {
  CallerTokenKeysBucket,
  callerTokenKeysBucketName,
  KeyRotation,
  SigningKey,
} from "@repo/frontdoor-infra";
import { SIGNING_KEY_REGION } from "@repo/frontdoor-shared";
import { gatewayRolePattern } from "@repo/gateway-infra";
import { NETWORK_REGION } from "@repo/infra-constructs";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { EnvironmentConfig } from "../config/types.ts";

export function frontdoorCallerTokenKeysStackName(
  environment: EnvironmentConfig,
): string {
  return `frontdoor-${environment.name}-caller-token-keys`;
}

/**
 * The caller token's keys: the KMS key that wraps the private keys the edge signs with, the bucket
 * every gateway reads the public keys from, and key rotation, which makes the keys under the
 * signing key, gives the edge its private keys and writes every public key to the bucket. One
 * stack, because all three are in the frontdoor account in eu-west-2. Protected from deletion,
 * and the key and the bucket are retained: without them, the edge can't sign and no gateway can
 * verify a token.
 */
export class FrontdoorCallerTokenKeysStack extends Stack {
  constructor(scope: Construct, environment: EnvironmentConfig) {
    super(scope, frontdoorCallerTokenKeysStackName(environment), {
      description: `Flex front door's caller token keys for the ${environment.name} environment`,
      env: {
        account: environment.frontdoor.account,
        region: SIGNING_KEY_REGION,
      },
      terminationProtection: true,
    });

    // Derived once, and given to both as a plain string: key rotation bakes it into its function.
    const bucketName = callerTokenKeysBucketName(
      environment.name,
      environment.frontdoor.account,
    );

    new SigningKey(this, "SigningKey", { environment: environment.name });
    new CallerTokenKeysBucket(this, "CallerTokenKeys", {
      bucketName,
      // Every gateway's role, by its name's pattern, in each domain account that runs a gateway. A
      // pattern, so adding a gateway doesn't change this stack, nor grow the policy toward its
      // size limit. An account is only ever one environment's, which config validation holds, so
      // the pattern reaches no other environment's gateways.
      readerRoles: environment.domainAccounts
        .filter(({ gateways }) => gateways.length > 0)
        .map(
          ({ account }) =>
            `arn:aws:iam::${account}:role/${gatewayRolePattern(environment.name)}`,
        ),
    });
    new KeyRotation(this, "KeyRotation", {
      environment: environment.name,
      publicKeysBucket: bucketName,
      publicKeysAccount: environment.frontdoor.account,
      publicKeysRegion: NETWORK_REGION,
    });
  }
}
