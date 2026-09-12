import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeadlineProvider } from "./context.ts";
import { createDriverContext } from "./context.ts";
import { GatewayError } from "./errors.ts";
import type { ResolvedPolicy } from "./policy.ts";

const testPolicy: ResolvedPolicy = {
  timeoutMs: 5_000,
  attempts: 1,
  circuitBreaker: { threshold: 5, durationMs: 120_000 },
  rateLimit: { rps: Infinity },
};

const noDeadline: DeadlineProvider = { remainingMs: () => Infinity };

describe("createDriverContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("upstream invokes the callback with an AbortSignal and returns its result", async () => {
    const ctx = createDriverContext(testPolicy, noDeadline);
    const result = await ctx.upstream((signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      return Promise.resolve({ id: "123" });
    });
    expect(result).toEqual({ id: "123" });
  });

  it("upstream propagates errors thrown by the callback", async () => {
    const ctx = createDriverContext(testPolicy, noDeadline);
    await expect(
      ctx.upstream(() => Promise.reject(new Error("upstream down"))),
    ).rejects.toThrow("upstream down");
  });

  it("supports multiple sequential attempts", async () => {
    const ctx = createDriverContext(testPolicy, noDeadline);
    const a = await ctx.upstream(() => Promise.resolve(1));
    const b = await ctx.upstream(() => Promise.resolve(2));
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("times out and throws UPSTREAM_TIMEOUT", async () => {
    const ctx = createDriverContext(testPolicy, noDeadline);

    const result = ctx
      .upstream(() => new Promise(() => {}))
      .catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(testPolicy.timeoutMs);

    const err = await result;
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("UPSTREAM_TIMEOUT");
  });

  it("passes signal that becomes aborted on timeout", async () => {
    const ctx = createDriverContext(testPolicy, noDeadline);
    let capturedSignal: AbortSignal | undefined;

    const result = ctx
      .upstream((signal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      })
      .catch(() => {});

    await vi.advanceTimersByTimeAsync(testPolicy.timeoutMs);
    await result;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("throws immediately when deadline is less than policy timeout", async () => {
    const longPolicy = { ...testPolicy, timeoutMs: 60_000 };
    const shortDeadline: DeadlineProvider = { remainingMs: () => 50 };
    const ctx = createDriverContext(longPolicy, shortDeadline);

    const fn = vi.fn(() => Promise.resolve("should not run"));
    try {
      await ctx.upstream(fn);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe("UPSTREAM_TIMEOUT");
      expect((err as GatewayError).message).toContain("Insufficient time");
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws immediately when no time remaining", async () => {
    const deadline: DeadlineProvider = { remainingMs: () => 0 };
    const ctx = createDriverContext(testPolicy, deadline);

    const fn = vi.fn(() => Promise.resolve("should not run"));
    try {
      await ctx.upstream(fn);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe("UPSTREAM_TIMEOUT");
      expect((err as GatewayError).message).toContain("Insufficient time");
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses policy timeout when deadline has no constraint", async () => {
    const ctx = createDriverContext(testPolicy, noDeadline);

    const result = ctx
      .upstream(() => new Promise(() => {}))
      .catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(testPolicy.timeoutMs);

    const err = await result;
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("UPSTREAM_TIMEOUT");
  });

  it("preserves GatewayError thrown by the callback", async () => {
    const ctx = createDriverContext(testPolicy, noDeadline);
    const original = new GatewayError(
      "UPSTREAM_REJECTED",
      "rejected by upstream",
    );

    try {
      await ctx.upstream(() => Promise.reject(original));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBe(original);
    }
  });
});
