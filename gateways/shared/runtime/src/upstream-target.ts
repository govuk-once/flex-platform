import type { SecretProvider } from "@repo/gateway-types";

import { createSecretProvider } from "./secret-provider.ts";

// Every driver takes its upstream location and its secret from the same two variables, so
// deployments configure gateways uniformly and a generated entrypoint needs no driver
// knowledge. What the target means is the driver's decision: a URL for one transport, an
// address or a resource identifier for another. The target is optional here: a driver may take
// the location from a field of the secret instead, where the configuration names one, and it is
// the driver that refuses to start when neither gives it one. The secret is always a JSON object
// in AWS Secrets Manager, and every gateway has one; which of its fields are read is declared by
// the driver's configuration and checked there.
export const UPSTREAM_TARGET_ENV = "UPSTREAM_TARGET";
export const UPSTREAM_SECRET_ARN_ENV = "UPSTREAM_SECRET_ARN";

type Env = Readonly<Record<string, string | undefined>>;

// Unset, or set to nothing but space, is no target: the two read alike to a deployment tool.
export function readUpstreamTarget(env: Env = process.env): string | undefined {
  const value = env[UPSTREAM_TARGET_ENV]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

// The full ARN of the secret. Its shape is checked where it is used, when the provider is
// built, so a misconfigured deployment still fails as it starts.
export function readUpstreamSecretArn(env: Env = process.env): string {
  const value = env[UPSTREAM_SECRET_ARN_ENV]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Environment variable ${UPSTREAM_SECRET_ARN_ENV} must be set`,
    );
  }
  return value;
}

export interface UpstreamOptions {
  readonly target?: string;
  readonly secret: SecretProvider;
}

// The driver's executor options, ready to pass to createExecutor: the target as deployed and
// a provider for the secret the deployment names. Nothing is retrieved here; the executor
// retrieves the secret when it is created.
export function readUpstreamOptions(env: Env = process.env): UpstreamOptions {
  const target = readUpstreamTarget(env);
  return {
    ...(target === undefined ? {} : { target }),
    secret: createSecretProvider(readUpstreamSecretArn(env)),
  };
}
