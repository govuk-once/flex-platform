import { describe, expectTypeOf, it } from "vitest";

import { ERROR_CODES, type ErrorRuling } from "./errors.ts";

describe("ERROR_CODES", () => {
  it("gives every code a ruling", () => {
    expectTypeOf(ERROR_CODES).toExtend<Readonly<Record<string, ErrorRuling>>>();
  });
});
