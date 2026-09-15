import { afterEach, describe, expect, it, vi } from "vitest";

describe("gateway.config", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads without environment variables, a secret or network access", async () => {
    // What a deployment supplies is read by the entrypoint, never by the configuration, so
    // codegen and review tooling can load it anywhere.
    delete process.env.UPSTREAM_TARGET;
    delete process.env.UPSTREAM_SECRET_ARN;
    delete process.env.AWS_REGION;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { default: config } = await import("./gateway.config.ts");

    expect(config.id).toBe("udp");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("declares no upstream authentication and expects the empty secret", async () => {
    const { default: config } = await import("./gateway.config.ts");
    const { auth } = config.driver;

    expect(auth.headers).toEqual([]);
    expect(auth.validateSecret({})).toBe(true);
    // A token placed in this gateway's secret is a mistake, not something to ignore.
    expect(auth.validateSecret({ token: "unused" })).toBe(false);
  });
});
