import { describe, expect, it } from "vitest";

import { domainFunctionName } from "./names.ts";

describe("domainFunctionName", () => {
  it("derives the name from the environment's and the domain's", () => {
    expect(domainFunctionName("sandbox", "domain-a")).toBe(
      "domain-sandbox-domain-a",
    );
  });
});
