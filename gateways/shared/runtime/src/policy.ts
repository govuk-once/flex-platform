import type { PolicyConfig } from "@repo/gateway-config";

import { parseDuration } from "./duration.ts";

export interface ResolvedPolicy {
  readonly timeoutMs: number;
  readonly circuitBreaker: {
    readonly threshold: number;
    readonly durationMs: number;
  };
  readonly rateLimit: {
    readonly rps: number;
  };
}

const DEFAULTS: ResolvedPolicy = {
  timeoutMs: 10_000,
  circuitBreaker: { threshold: 5, durationMs: 120_000 },
  rateLimit: { rps: Infinity },
};

export function resolvePolicy(raw: PolicyConfig | undefined): ResolvedPolicy {
  const timeoutMs =
    raw?.upstreamTimeout !== undefined
      ? parseDuration(raw.upstreamTimeout)
      : DEFAULTS.timeoutMs;

  // Reject a non-positive timeout during handler creation; it would prevent every upstream call.
  if (timeoutMs <= 0) {
    throw new TypeError(
      `Policy upstreamTimeout must be greater than zero, got ${JSON.stringify(raw?.upstreamTimeout)}`,
    );
  }

  return {
    timeoutMs,
    circuitBreaker: {
      threshold:
        raw?.circuitBreaker?.threshold ?? DEFAULTS.circuitBreaker.threshold,
      durationMs:
        raw?.circuitBreaker?.duration !== undefined
          ? parseDuration(raw.circuitBreaker.duration)
          : DEFAULTS.circuitBreaker.durationMs,
    },
    rateLimit: {
      rps: raw?.rateLimit?.rps ?? DEFAULTS.rateLimit.rps,
    },
  };
}
