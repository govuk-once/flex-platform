import {
  connect,
  type ContractOperations,
  type GatewayClient,
  type OperationName,
} from "./client.ts";

export type {
  CallOptions,
  ContractOperation,
  ContractOperations,
  GatewayClient,
  InvocationFailure,
  OperationName,
} from "./client.ts";
export { GatewayInvocationError } from "./client.ts";

/**
 * A client for the gateway with this id, in the environment `FLEX_ENVIRONMENT` names, with a
 * function for each of `operations`, typed by its contract's `Operations`. A gateway's own client
 * package calls this for its domains.
 */
export function createGatewayClient<
  TOperations extends ContractOperations<TOperations>,
>(
  gatewayId: string,
  operations: readonly OperationName<TOperations>[],
): GatewayClient<TOperations> {
  return connect<TOperations>(
    () => namedEnvironment(gatewayId),
    gatewayId,
    operations,
  );
}

// Read on the client's first call, not as it is created, so creating one needs no environment.
// A call without it fails with this error, which is not a GatewayInvocationError: the function
// is set up wrongly, and no gateway failed to answer.
function namedEnvironment(gatewayId: string): string {
  const environment = process.env["FLEX_ENVIRONMENT"];
  if (environment === undefined) {
    throw new Error(
      `FLEX_ENVIRONMENT is not set, so the gateway ${JSON.stringify(gatewayId)} cannot be named.`,
    );
  }
  return environment;
}
