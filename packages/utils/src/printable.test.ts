import { describe, expect, it } from "vitest";

import { printable } from "./printable.ts";

describe("printable", () => {
  it("writes every character that does not display as its code point, line breaks included", () => {
    expect(printable("a\u001b[2Kb\nc\u202e")).toBe("aU+001B[2KbU+000AcU+202E");
  });
});
