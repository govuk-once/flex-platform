import { assert, describe, expect, it } from "vitest";

import { formatSource } from "./output.ts";

describe("formatSource", () => {
  it("refuses output it cannot parse, keeping the formatter's reason as the cause", async () => {
    const refusal = await formatSource("export const = ;", "babel").catch(
      (caught: unknown) => caught,
    );

    assert.instanceOf(refusal, Error);
    expect(refusal.message).toBe("Generated output is not parseable");
    expect(refusal.cause).toBeInstanceOf(Error);
  });
});
