import { describe, expect, it } from "vitest";

import { GatewayError } from "./errors.ts";

describe("GatewayError", () => {
  it("carries code and message", () => {
    const err = new GatewayError("INVALID_INPUT", "bad input");
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toBe("bad input");
    expect(err.name).toBe("GatewayError");
  });

  it("is an instance of Error", () => {
    const err = new GatewayError("INTERNAL", "boom");
    expect(err).toBeInstanceOf(Error);
  });
});
