import { describe, expect, it } from "vitest";

import { printableText } from "./printable-text.ts";

describe("printableText", () => {
  it("keeps the lines a message was written on and escapes the rest", () => {
    expect(printableText("first \u001b[1A\nsecond\u2028line")).toBe(
      "first U+001B[1A\nsecondU+2028line",
    );
  });
});
