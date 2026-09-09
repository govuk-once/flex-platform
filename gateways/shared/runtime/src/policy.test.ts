import { describe, expect, it } from "vitest";

import { resolvePolicy } from "./policy.ts";

describe("resolvePolicy", () => {
  it("resolves standard policy defaults", () => {
    const resolved = resolvePolicy({
      upstreamTimeout: "10s",
      attempts: 1,
      circuitBreaker: { threshold: 5, duration: "120s" },
    });

    expect(resolved.timeoutMs).toBe(10_000);
    expect(resolved.attempts).toBe(1);
    expect(resolved.circuitBreaker.threshold).toBe(5);
    expect(resolved.circuitBreaker.durationMs).toBe(120_000);
    expect(resolved.rateLimit.rps).toBe(Infinity);
  });

  it("resolves undefined policy with defaults", () => {
    const resolved = resolvePolicy(undefined);

    expect(resolved.timeoutMs).toBe(10_000);
    expect(resolved.attempts).toBe(1);
    expect(resolved.circuitBreaker.threshold).toBe(5);
    expect(resolved.circuitBreaker.durationMs).toBe(120_000);
    expect(resolved.rateLimit.rps).toBe(Infinity);
  });

  it("resolves empty policy with defaults", () => {
    const resolved = resolvePolicy({});

    expect(resolved.timeoutMs).toBe(10_000);
    expect(resolved.attempts).toBe(1);
  });

  it("parses custom timeout", () => {
    const resolved = resolvePolicy({ upstreamTimeout: "3s" });

    expect(resolved.timeoutMs).toBe(3_000);
  });

  it("overrides individual fields while keeping other defaults", () => {
    const resolved = resolvePolicy({ attempts: 3 });

    expect(resolved.attempts).toBe(3);
    expect(resolved.timeoutMs).toBe(10_000);
  });

  it("parses circuit breaker duration", () => {
    const resolved = resolvePolicy({
      circuitBreaker: { duration: "60s" },
    });

    expect(resolved.circuitBreaker.durationMs).toBe(60_000);
    expect(resolved.circuitBreaker.threshold).toBe(5);
  });

  it("resolves rate limit rps", () => {
    const resolved = resolvePolicy({ rateLimit: { rps: 100 } });

    expect(resolved.rateLimit.rps).toBe(100);
  });

  it("throws on invalid duration at cold start", () => {
    expect(() => resolvePolicy({ upstreamTimeout: "bad" })).toThrow(
      "Invalid duration",
    );
  });

  it("throws on invalid circuit breaker duration", () => {
    expect(() =>
      resolvePolicy({ circuitBreaker: { duration: "nope" } }),
    ).toThrow("Invalid duration");
  });
});
