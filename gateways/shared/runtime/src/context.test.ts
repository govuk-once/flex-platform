import { describe, expect, it } from "vitest";

import { createDriverContext } from "./context.ts";

describe("createDriverContext", () => {
  it("attempt invokes the callback and returns its result", async () => {
    const ctx = createDriverContext();
    const result = await ctx.attempt(() => Promise.resolve({ id: "123" }));
    expect(result).toEqual({ id: "123" });
  });

  it("attempt propagates errors thrown by the callback", async () => {
    const ctx = createDriverContext();
    await expect(
      ctx.attempt(() => Promise.reject(new Error("upstream down"))),
    ).rejects.toThrow("upstream down");
  });

  it("supports multiple sequential attempts", async () => {
    const ctx = createDriverContext();
    const a = await ctx.attempt(() => Promise.resolve(1));
    const b = await ctx.attempt(() => Promise.resolve(2));
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});
