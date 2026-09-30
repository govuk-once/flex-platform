import { describe, expect, it, vi } from "vitest";

import { checkValue } from "./check-value.ts";

// What a schema makes of a value, which is the library's answer rather than a reading of the
// keywords. Each case here is one a reading of them got wrong.
describe("checkValue", () => {
  const admits = (schema: unknown, value: unknown, components = {}) =>
    checkValue(schema, value, components).verdict === "admitted";

  it("reads a branch against the value the whole is held to", () => {
    // The branch says nothing of the type, so a reading that took it on its own would hold the
    // text to a bound that only a number has.
    const bounded = { type: "integer", allOf: [{ minimum: 10 }] };
    expect(admits(bounded, 1)).toBe(false);
    expect(admits(bounded, 11)).toBe(true);
  });

  it("holds a value to what a name leads to and to what is written beside it", () => {
    const named = { $ref: "#/components/schemas/Id", enum: ["good"] };
    const components = { Id: { type: "string" } };
    expect(admits(named, "bad", components)).toBe(false);
    expect(admits(named, "good", components)).toBe(true);
  });

  it("reads a flag as the schema it is", () => {
    expect(admits(false, "anything")).toBe(false);
    expect(admits(true, "anything")).toBe(true);
  });

  it("reads a list of types as the types it lists", () => {
    const listed = { type: ["integer", "null"] };
    expect(admits(listed, "bad")).toBe(false);
    expect(admits(listed, null)).toBe(true);
    expect(admits(listed, 1)).toBe(true);
  });

  it("holds a value to a const and an enum at once", () => {
    const both = { const: "bad", enum: ["good"] };
    expect(admits(both, "bad")).toBe(false);
    expect(admits(both, "good")).toBe(false);
  });

  it("counts a string's length in what a reader sees", () => {
    // One emoji is one character to a reader and two units to the machine.
    expect(admits({ type: "string", minLength: 2 }, "\u{1F600}")).toBe(false);
    expect(admits({ type: "string", maxLength: 1 }, "\u{1F600}")).toBe(true);
  });

  it("holds a value to a format, as the generated validators do", () => {
    const identifier = { type: "string", format: "uuid" };
    expect(admits(identifier, "not one")).toBe(false);
    expect(admits(identifier, "0192e5a0-9d0c-7000-8000-000000000000")).toBe(
      true,
    );
  });

  it("says what was wrong in the schema's own words, never in the value's", () => {
    expect(checkValue({ type: "string", enum: ["good"] }, "bad")).toEqual({
      verdict: "refused",
      problems: ["must be equal to one of the allowed values"],
    });
    expect(checkValue({ type: "integer" }, "bad")).toEqual({
      verdict: "refused",
      problems: ["must be integer"],
    });
  });

  it("refuses a number JSON cannot write, as the generated validators do", () => {
    // Reading a schema with the library's strictness off takes this with it, and a validator
    // generated with it on refuses both. What the upstream takes is the validator's answer.
    expect(admits({ type: "number" }, Number.POSITIVE_INFINITY)).toBe(false);
    expect(admits({ type: "number" }, Number.NaN)).toBe(false);
    expect(admits({ type: "integer" }, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("answers with what it could not apply rather than writing it anywhere", () => {
    // A format is the document's own word, so it reaches the line as the document wrote it.
    // Said here, it leaves through whatever makes a diagnostic safe to print; written by the
    // library, it would reach a terminal as it stands.
    const watched = ["log", "warn", "error"] as const;
    const spies = watched.map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      // Unchecked rather than refused: nothing says the value is not one the format admits.
      expect(
        checkValue({ type: "string", format: "weird\u001b[2K" }, "anything"),
      ).toEqual({
        verdict: "unchecked",
        problems: [
          'unknown format "weird\u001b[2K" ignored in schema at path "#"',
        ],
      });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("refuses a schema whose validation is asynchronous rather than running it", async () => {
    // Such a schema compiles to a validator answering with a promise, and a promise is a value:
    // read as an answer it is one that passed, and what it settles to comes back with nothing
    // waiting for it.
    const rejections: unknown[] = [];
    const watch = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", watch);
    try {
      expect(
        checkValue({ $async: true, type: "integer", minimum: 10 }, 1),
      ).toEqual({
        verdict: "unchecked",
        problems: [
          '"$async" is not supported, because validation is synchronous',
        ],
      });
      // One with nothing waiting for it is reported a turn later, so there is one to wait.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", watch);
    }
  });

  it("says so when the schema itself cannot be read", () => {
    const check = checkValue({ type: 1 }, "anything");
    expect(check.verdict).toBe("unchecked");
    expect(check.verdict === "admitted" ? [] : check.problems).toEqual([
      expect.stringContaining("the schema cannot be read"),
    ]);
  });
});
