import {
  edgeRoleName,
  KeyRotation,
  publicKeysTableName,
  PushIdSecret,
  SigningKey,
  signingKeyAliasName,
} from "@repo/frontdoor-infra";
import { SIGNING_KEY_REGION } from "@repo/frontdoor-shared";
import { gatewayRolePattern } from "@repo/gateway-infra";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type { EnvironmentConfig } from "../config/types.ts";

export function frontdoorCallerTokenKeysStackName(
  environment: EnvironmentConfig,
): string {
  return `frontdoor-${environment.name}-caller-token-keys`;
}

/**
 * The caller token's public keys table, by ARN, which every gateway reads, across accounts,
 * through its network's `dynamodb` endpoint. An interface endpoint reaches its own region's tables
 * alone, so the table's region is the networks', which a test holds.
 */
export function callerTokenPublicKeysTableArn(
  environment: EnvironmentConfig,
): string {
  const table = publicKeysTableName(environment.name, "caller-token");
  return `arn:aws:dynamodb:${SIGNING_KEY_REGION}:${environment.frontdoor.account}:table/${table}`;
}

/**
 * The caller token's keys: the KMS key that wraps the private keys the edge signs with, and key
 * rotation, which makes the keys under the signing key and keeps them in its two tables, where the
 * edge reads its private keys and every gateway the public keys. With them, the secret the edge
 * derives each caller's push ID with, which the token holds. One stack, because all three are in
 * the frontdoor account in eu-west-2. Protected from deletion, and the key, the tables and the
 * secret are retained: without them, the edge can't sign and no gateway can verify a token.
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

    const { account } = environment.frontdoor;

    new SigningKey(this, "SigningKey", { environment: environment.name });
    new PushIdSecret(this, "PushIdSecret", { environment: environment.name });
    new KeyRotation(this, "KeyRotation", {
      environment: environment.name,
      kind: "caller-token",
      keyAlias: signingKeyAliasName(environment.name),
      // The edge's role, which signs with the private keys. Its stack deploys after this one.
      privateKeyReaderRoleArns: [
        `arn:aws:iam::${account}:role/${edgeRoleName(environment.name)}`,
      ],
      // Every gateway's role, by its name's pattern, in each domain account that runs a gateway. A
      // pattern, so adding a gateway doesn't change this stack, nor grow the policy toward its
      // size limit. An account is only ever one environment's, which config validation holds, so
      // the pattern reaches no other environment's gateways.
      publicKeyReaderRoleArns: environment.domainAccounts
        .filter(({ gateways }) => gateways.length > 0)
        .map(
          ({ account: domainAccount }) =>
            `arn:aws:iam::${domainAccount}:role/${gatewayRolePattern(environment.name)}`,
        ),
    });
  }
}
