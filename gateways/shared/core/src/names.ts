// A gateway's function is reached by a name derived from its environment and its id. The client
// that calls it and the stack that deploys it both build the name here, so a domain is never
// given one.

import { isPlatformName } from "@repo/utils/is-platform-name";

// Lambda's limit on a function's name, without its qualifier.
const FUNCTION_NAME_LENGTH = 64;

// The rule for a name in the infrastructure's config, which an environment's name is, so a
// gateway's id is held to it too.
function assertPlatformName(kind: string, name: string): void {
  if (!isPlatformName(name)) {
    throw new Error(
      `The ${kind} ${JSON.stringify(name)} must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen.`,
    );
  }
}

/** Refuses an id that cannot name a gateway's function or its client package. */
export function assertGatewayId(gatewayId: string): void {
  assertPlatformName("gateway id", gatewayId);
}

/**
 * The start of every gateway's function name in an environment, `gateway-<environment>-`. Every
 * domain in the environment may invoke a function with this prefix, so nothing else is given it.
 */
export function gatewayFunctionPrefix(environment: string): string {
  assertPlatformName("environment", environment);
  return `gateway-${environment}-`;
}

/** The gateway's function name, `gateway-<environment>-<id>`. */
export function gatewayFunctionName(
  environment: string,
  gatewayId: string,
): string {
  assertGatewayId(gatewayId);
  const name = `${gatewayFunctionPrefix(environment)}${gatewayId}`;
  if (name.length > FUNCTION_NAME_LENGTH) {
    throw new Error(
      `The function name ${name} is longer than Lambda's ${FUNCTION_NAME_LENGTH} characters.`,
    );
  }
  return name;
}

/** The one alias of a gateway's function, which every client invokes. */
export const GATEWAY_FUNCTION_ALIAS = "live";
