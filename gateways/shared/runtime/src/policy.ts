import type { PolicyConfig } from "@repo/gateway-config";

import { parseDuration } from "./duration.ts";

export interface ResolvedPolicy {
  readonly timeoutMs: number;
  readonly attempts: number;
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
  attempts: 1,
  circuitBreaker: { threshold: 5, durationMs: 120_000 },
  rateLimit: { rps: Infinity },
};

export function resolvePolicy(raw: PolicyConfig | undefined): ResolvedPolicy {
  return {
    timeoutMs:
      raw?.upstreamTimeout !== undefined
        ? parseDuration(raw.upstreamTimeout)
        : DEFAULTS.timeoutMs,
    attempts: raw?.attempts ?? DEFAULTS.attempts,
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
