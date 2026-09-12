import { GatewayError } from "./errors.ts";
import type { ResolvedPolicy } from "./policy.ts";

export interface DriverContext {
  upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

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

export function createDriverContext(
  policy: ResolvedPolicy,
  deadline: DeadlineProvider,
): DriverContext {
  return {
    async upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (deadline.remainingMs() < policy.timeoutMs) {
        throw new GatewayError(
          "UPSTREAM_TIMEOUT",
          "Insufficient time remaining for upstream call",
        );
      }

      // STUB: Circuit breaker gate (fast-fail while open)
      // STUB: Rate limit gate

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
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
