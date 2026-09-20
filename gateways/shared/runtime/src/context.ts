import type { DriverContext } from "@repo/gateway-types";

import { GatewayError } from "./errors.ts";
import type { ResolvedPolicy } from "./policy.ts";

export interface DeadlineProvider {
  remainingMs(): number;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

// What a driver reported about one exchange, as it reported it. Nothing here is trusted: the
// handler decides what of it a caller and a log see.
export type ReportedMeta = Map<string, unknown>;

export function createDriverContext(
  policy: ResolvedPolicy,
  deadline: DeadlineProvider,
  reported: ReportedMeta = new Map(),
): DriverContext {
  return {
    meta(name: string, value: unknown): void {
      reported.set(name, value);
    },

    async upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const remaining = deadline.remainingMs();
      if (remaining <= 0) {
        throw new GatewayError(
          "UPSTREAM_TIMEOUT",
          "Deadline exhausted before the upstream call",
        );
      }

      const budget = Math.min(policy.timeoutMs, remaining);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      const { signal } = controller;

      try {
        const result = await Promise.race([fn(signal), rejectOnAbort(signal)]);
        clearTimeout(timer);
        return result;
      } catch (err: unknown) {
        clearTimeout(timer);
        if (signal.aborted) {
          throw new GatewayError("UPSTREAM_TIMEOUT", "Upstream call timed out");
        }
        throw err;
      }
    },
  };
}
