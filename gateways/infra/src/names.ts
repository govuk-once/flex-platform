// Names derived from config, so nothing reads one back from a deployed stack. A gateway's function
// is named by `gatewayFunctionName` in @repo/gateway-core, which the client that invokes it uses
// too:
//
//   gateway-{environment}-{id}    a gateway's function
//
// The prefix is a boundary: the domain account's network and its domains' role let a domain invoke
// any function whose name starts with `gateway-{environment}-`. So no other function the gateways
// section creates may have it.

import { gatewayFunctionPrefix } from "@repo/gateway-core";

/** Every gateway's function in the environment, and each one's versions and aliases. */
export function gatewayFunctionPattern(environment: string): string {
  return `${gatewayFunctionPrefix(environment)}*`;
}
