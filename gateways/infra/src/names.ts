// Names derived from config, so nothing reads one back from a deployed stack. A gateway's function
// is named by `gatewayFunctionName` in @repo/gateway-core, which the client that invokes it uses
// too:
//
//   gateway-{environment}-{id}              a gateway's function, and its secret if it has its own
//   gateway-{environment}-{id}-execution    the role its function runs as
//   /flex/gateway/{environment}/{id}/function  its log group
//
// The prefix is a boundary: the Lambda endpoint in the domain account's network, and each domain's
// execution role, let a domain invoke any function whose name starts with `gateway-{environment}-`.
// So no other function the gateways section creates may have it.
//
// The same holds for roles and secrets. The network's `secretsmanager` and `sts` endpoints let any
// role named `gateway-{environment}-*-execution` through, to any secret named
// `gateway-{environment}-*` in the account, and the caller token's public keys bucket lets any role
// named that way in a domain account read them. So no other role or secret may have those names.

import { gatewayFunctionName, gatewayFunctionPrefix } from "@repo/gateway-core";

// IAM's limit on a role's name.
const ROLE_NAME_LENGTH = 64;

/** Every gateway's function in the environment, and each one's versions and aliases. */
export function gatewayFunctionPattern(environment: string): string {
  return `${gatewayFunctionPrefix(environment)}*`;
}

/** The role every gateway's function in the environment runs as. */
export function gatewayRolePattern(environment: string): string {
  return `${gatewayFunctionPrefix(environment)}*-execution`;
}

/**
 * Every secret a gateway's stack creates in the environment, with the six characters Secrets
 * Manager adds to each one's ARN.
 */
export function gatewaySecretPattern(environment: string): string {
  return `${gatewayFunctionPrefix(environment)}*`;
}

/** The role a gateway's function runs as. */
export function gatewayRoleName(
  environment: string,
  gatewayId: string,
): string {
  const name = `${gatewayFunctionName(environment, gatewayId)}-execution`;
  if (name.length > ROLE_NAME_LENGTH) {
    throw new Error(
      `The role name ${name} is longer than IAM's ${ROLE_NAME_LENGTH} characters.`,
    );
  }
  return name;
}

/** The log group a gateway's function writes to. */
export function gatewayLogGroupName(
  environment: string,
  gatewayId: string,
): string {
  gatewayFunctionName(environment, gatewayId);
  return `/flex/gateway/${environment}/${gatewayId}/function`;
}

/**
 * The secret a gateway's stack creates, for a gateway whose upstream doesn't hold one. Secrets
 * Manager adds six characters of its own to the ARN, so a policy names it by a pattern.
 */
export function gatewaySecretName(
  environment: string,
  gatewayId: string,
): string {
  return gatewayFunctionName(environment, gatewayId);
}
