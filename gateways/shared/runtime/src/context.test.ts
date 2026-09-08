import { describe, expect, it } from "vitest";

import { createDriverContext } from "./context.ts";

describe("createDriverContext", () => {
  it("call invokes the callback and returns its result", async () => {
    const ctx = createDriverContext();
    const result = await ctx.call(() => Promise.resolve({ id: "123" }));
    expect(result).toEqual({ id: "123" });
  });

  it("call propagates errors thrown by the callback", async () => {
    const ctx = createDriverContext();
    await expect(
      ctx.call(() => Promise.reject(new Error("upstream down"))),
    ).rejects.toThrow("upstream down");
  });

  it("supports multiple sequential calls", async () => {
    const ctx = createDriverContext();
    const a = await ctx.call(() => Promise.resolve(1));
    const b = await ctx.call(() => Promise.resolve(2));
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});
