/**
 * SDK-level bounds on one call a gateway makes to AWS: reading its secret, its caller token's
 * keys, or assuming a role. A request's attempt keeps its own deadline, but such a call may be
 * shared by every request that waits for it, and one that never settled would leave each of them
 * waiting until they timed out. Without `throwOnRequestTimeout` the SDK only logs a breach of
 * `requestTimeout`.
 */
export const AWS_REQUEST_HANDLER = {
  connectionTimeout: 2_000,
  requestTimeout: 5_000,
  throwOnRequestTimeout: true,
} as const;
