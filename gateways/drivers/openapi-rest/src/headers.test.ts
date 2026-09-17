import { describe, expect, it } from "vitest";

import {
  isValidHeaderValue,
  isVerbatimHeaderValue,
  normaliseHeaderName,
  validateHeaders,
} from "./headers.ts";

// A newline or carriage return at either edge would end the header and let what follows be
// read as framing. Internal ones are covered separately; both checks refuse either position.
const FRAMING_VALUES = ["\nkey", "key\n", "key\r", "key\r\n"];

describe("normaliseHeaderName", () => {
  it("lowercases valid names", () => {
    expect(normaliseHeaderName("X-Request-Id", "ctx")).toBe("x-request-id");
  });

  it.each([
    "content-type",
    "Content-Length",
    "HOST",
    "transfer-encoding",
    "connection",
  ])("rejects reserved header %s", (name) => {
    expect(() => normaliseHeaderName(name, "ctx")).toThrow(/set by the driver/);
  });

  it.each(["", "x y", "x:y", "x\ny"])("rejects invalid name %j", (name) => {
    expect(() => normaliseHeaderName(name, "ctx")).toThrow(
      /not a valid header name/,
    );
  });
});

describe("validateHeaders", () => {
  it("returns a Headers object with normalised names", () => {
    const headers = validateHeaders({ "X-Api-Version": "2" }, "ctx");
    expect(headers.get("x-api-version")).toBe("2");
  });

  it.each([
    "SYNTHETIC_SECRET_123\ninvalid",
    "SYNTHETIC_SECRET_123\rinvalid",
    "SYNTHETIC_SECRET_123\u0000",
    "SYNTHETIC_SECRET_123\u0001",
    "SYNTHETIC_SECRET_123\u007f",
    "SYNTHETIC_SECRET_123\u0100",
  ])("rejects invalid value %j without quoting it", (value) => {
    const err = (() => {
      try {
        validateHeaders({ "x-token": value }, "ctx");
      } catch (e: unknown) {
        return e as Error;
      }
      return new Error("did not throw");
    })();
    expect(err.message).toBe('ctx: header "x-token" has an invalid value');
    expect(err.message).not.toContain("SYNTHETIC_SECRET");
    expect(err.cause).toBeUndefined();
  });

  it("rejects a non-string value", () => {
    expect(() =>
      validateHeaders({ "x-n": 1 as unknown as string }, "ctx"),
    ).toThrow('ctx: header "x-n" has an invalid value');
  });

  // The Headers class strips surrounding spaces and tabs, which is why a credential goes
  // through isVerbatimHeaderValue first; a header the configuration sets may still be padded.
  it("returns values as the transport will send them", () => {
    const headers = validateHeaders(
      {
        "x-padded": " \tkey\t ",
        "x-nbsp": "\u00a0key\u00a0",
        "x-tab": "a\tb",
        "x-empty": "",
      },
      "ctx",
    );
    expect(headers.get("x-padded")).toBe("key");
    expect(headers.get("x-nbsp")).toBe("\u00a0key\u00a0");
    expect(headers.get("x-tab")).toBe("a\tb");
    expect(headers.get("x-empty")).toBe("");
  });

  it("includes the context in errors", () => {
    expect(() => validateHeaders({ host: "x" }, "Executor headers")).toThrow(
      /^Executor headers: /,
    );
  });
});

describe("isValidHeaderValue", () => {
  it.each(["a\tb", "a\u00ffb", "a\u00a0b", " padded ", ""])(
    "accepts %j",
    (value) => {
      expect(isValidHeaderValue(value)).toBe(true);
    },
  );

  // The ends of the permitted ranges, and the codes either side of the one control character
  // that is allowed.
  it("accepts the range boundaries and refuses the codes around tab", () => {
    expect(isValidHeaderValue("a\u007eb")).toBe(true);
    expect(isValidHeaderValue("a\u0080b")).toBe(true);
    expect(isValidHeaderValue("a\u0009b")).toBe(true);
    expect(isValidHeaderValue("a\u0008b")).toBe(false);
    expect(isValidHeaderValue("a\u000bb")).toBe(false);
  });

  it.each(FRAMING_VALUES)("rejects %j at an edge", (value) => {
    expect(isValidHeaderValue(value)).toBe(false);
  });

  // What Node's transport refuses at send time, so it is refused here first.
  it.each([
    "a\u0001b",
    "a\u007fb",
    "a\nb",
    "a\rb",
    "a\u0000b",
    "a\u001fb",
    "a\u0100b",
    "a\u{1f600}b",
  ])("rejects %j", (value) => {
    expect(isValidHeaderValue(value)).toBe(false);
  });
});

describe("isVerbatimHeaderValue", () => {
  // A non-breaking space is not HTTP whitespace: the transport sends it, so it is kept.
  it.each(["key", "a b", "a\tb", "\u00a0k", "k\u00a0"])(
    "accepts %j",
    (value) => {
      expect(isVerbatimHeaderValue(value)).toBe(true);
    },
  );

  // Headers strips leading and trailing spaces and tabs, so these would not be sent as stored.
  it.each([
    " key",
    "key ",
    "\tkey",
    "key\t",
    "   ",
    "\t",
    "a\u0001b",
    "a\u0100b",
  ])("rejects %j", (value) => {
    expect(isVerbatimHeaderValue(value)).toBe(false);
  });

  it.each(FRAMING_VALUES)("rejects %j at an edge", (value) => {
    expect(isVerbatimHeaderValue(value)).toBe(false);
  });

  // Emptiness is not this check's to report: a secret field is rejected for its length first,
  // and a header the configuration sets may legitimately be empty.
  it("accepts the empty string", () => {
    expect(isVerbatimHeaderValue("")).toBe(true);
  });
});
