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

/** The variable a domain's function is given, naming the environment it runs in. */
export const ENVIRONMENT_VARIABLE = "FLEX_ENVIRONMENT";

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
  // Read once, as the client is created, so a function without it fails as it starts.
  const environment = process.env[ENVIRONMENT_VARIABLE];
  if (environment === undefined) {
    throw new Error(
      `${ENVIRONMENT_VARIABLE} is not set, so the gateway ${JSON.stringify(gatewayId)} cannot be named.`,
    );
  }
  return connect<TOperations>(environment, gatewayId, operations);
}
