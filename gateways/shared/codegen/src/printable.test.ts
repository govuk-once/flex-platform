import { describe, expect, it } from "vitest";

import { printable, printableText } from "./printable.ts";

describe("printable", () => {
  it("writes every character that does not display as its code point, line breaks included", () => {
    expect(printable("a\u001b[2Kb\nc\u202e")).toBe("aU+001B[2KbU+000AcU+202E");
  });
});

describe("printableText", () => {
  it("keeps the lines a message was written on and escapes the rest", () => {
    expect(printableText("first \u001b[1A\nsecond\u2028line")).toBe(
      "first U+001B[1A\nsecondU+2028line",
    );
  });
});
