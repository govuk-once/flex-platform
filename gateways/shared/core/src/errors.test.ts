import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "./index.ts";

const signalOf = (code: keyof typeof ERROR_CODES) => ERROR_CODES[code].signal;

describe("ERROR_CODES", () => {
  it("counts an upstream's own answer as a response, not a failure", () => {
    expect(signalOf("NOT_FOUND")).toBe("upstream_success");
    expect(signalOf("UPSTREAM_REJECTED")).toBe("upstream_success");
  });

  it("counts contract violations and timeouts as failures", () => {
    expect(signalOf("UPSTREAM_CONTRACT_VIOLATION")).toBe("upstream_failure");
    expect(signalOf("UPSTREAM_TIMEOUT")).toBe("upstream_failure");
  });

  // A control's own output is never fed back into it.
  it("keeps the gateway's own rate limit neutral to upstream health", () => {
    expect(signalOf("RATE_LIMITED")).toBe("none");
  });
});
