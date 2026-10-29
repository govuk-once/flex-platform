// Names derived from config, so nothing reads one back from a deployed stack. A gateway's function
// is named by the gateway's id, which its package names (`@repo/gateway-service-<id>`):
//
//   gateway-{environment}-{id}    a gateway's function
//
// The prefix is a boundary: the domain account's network and its domains' role let a domain invoke
// any function whose name starts with `gateway-{environment}-`. So no other function the gateways
// section creates may have it.

export function gatewayFunctionName(environment: string, id: string): string {
  return `gateway-${environment}-${id}`;
}

/** Every gateway's function in the environment, and each one's versions and aliases. */
export function gatewayFunctionPattern(environment: string): string {
  return gatewayFunctionName(environment, "*");
}
