import { describe, expect, it } from "vitest";

import { createRedactor, REDACTED } from "./redact.ts";

describe("createRedactor", () => {
  const redactor = createRedactor();

  it("replaces a field whose name looks like a secret or like personal data", () => {
    expect(
      redactor.redact({
        apiKey: "SYNTHETIC_API_KEY",
        Authorization: "Bearer x",
        email: "someone",
        nested: { surname: "x", kept: "yes" },
        list: [{ password: "x" }],
        kept: "yes",
      }),
    ).toEqual({
      apiKey: REDACTED,
      Authorization: REDACTED,
      email: REDACTED,
      nested: { surname: REDACTED, kept: "yes" },
      list: [{ password: REDACTED }],
      kept: "yes",
    });
  });

  it.each([
    ["a JWT", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.sig"],
    ["an email address", "someone@example.com"],
    ["a UK phone number", "07123456789"],
    ["a National Insurance number", "QQ123456C"],
    ["a postcode", "SW1A 1AA"],
    ["an IPv4 address", "192.168.0.1"],
    ["a card number", "4111 1111 1111 1111"],
  ])("replaces a value that looks like %s, under any name", (_, value) => {
    expect(redactor.redact({ kept: value })).toEqual({ kept: REDACTED });
    expect(redactor.redactString(`before ${value} after`)).toBe(REDACTED);
  });

  it("keeps a long number that is not a card number", () => {
    expect(redactor.redactString("order 1234567890123")).toBe(
      "order 1234567890123",
    );
  });

  it("takes a domain's own patterns", () => {
    const own = createRedactor({
      redactKeys: [/^claimRef$/],
      redactValues: [/^CLM-\d+$/],
    });
    expect(own.redact({ claimRef: "x", other: "CLM-123", kept: "y" })).toEqual({
      claimRef: REDACTED,
      other: REDACTED,
      kept: "y",
    });
  });

  it("leaves what is not plain data as it is", () => {
    const date = new Date(0);
    expect(redactor.redact({ date, n: 1, b: false, nil: null })).toEqual({
      date,
      n: 1,
      b: false,
      nil: null,
    });
  });
});
