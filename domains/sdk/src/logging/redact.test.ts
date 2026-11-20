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
    "phoneNumber",
    "userSurname",
    "bank_account_number",
    "applicantDob",
    "emailaddress",
    "home-phone",
    "clientIPAddress",
    "api-key",
  ])("replaces %s, a compound of a name it knows", (key) => {
    expect(redactor.redact({ [key]: "x" })).toEqual({ [key]: REDACTED });
  });

  it("keeps a field whose name only holds a short name's letters", () => {
    const kept = { panel: "x", shipAddress: "x", automobile: "x" };
    expect(redactor.redact(kept)).toEqual(kept);
  });

  it.each([
    ["a JWT", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.sig"],
    ["an email address", "someone@example.com"],
    ["a UK phone number", "07123456789"],
    ["a UK phone number in groups", "07700 900123"],
    ["a UK phone number with its country code", "+44 7700 900123"],
    ["a UK landline in groups", "020 7946 0958"],
    ["a National Insurance number", "QQ123456C"],
    ["a postcode", "SW1A 1AA"],
    ["an IPv4 address", "192.168.0.1"],
    ["a card number", "4111 1111 1111 1111"],
    ["a card number after a reference", "ref 12 4111 1111 1111 1111"],
    ["a card number after a date", "2026-11-10 4111-1111-1111-1111"],
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

  it("answers the same every time for a pattern that remembers its last match", () => {
    const redactKeys = [/claim/g];
    const redactValues = [/CLM-\d+/g, /CLM/y];
    const own = createRedactor({ redactKeys, redactValues });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(own.redact({ claimRef: "x", other: "CLM-123" })).toEqual({
        claimRef: REDACTED,
        other: REDACTED,
      });
    }
    // The domain's own patterns are left as they were.
    expect([...redactKeys, ...redactValues].map((p) => p.lastIndex)).toEqual([
      0, 0, 0,
    ]);
  });

  it("writes what is not data as JSON would", () => {
    const date = new Date(0);
    expect(redactor.redact({ date, n: 1, b: false, nil: null })).toEqual({
      date: date.toISOString(),
      n: 1,
      b: false,
      nil: null,
    });
    expect(redactor.redact({ map: new Map([["email", "x"]]) })).toEqual({
      map: {},
    });
  });

  it("redacts the fields of a class instance and of an object with no prototype", () => {
    class Claim {
      readonly email = "someone";
      readonly note = "someone@example.com";
      readonly kept = "yes";
    }
    const bare = Object.assign(Object.create(null) as object, {
      password: "SYNTHETIC",
      kept: "yes",
    });
    expect(redactor.redact({ claim: new Claim(), bare })).toEqual({
      claim: { email: REDACTED, note: REDACTED, kept: "yes" },
      bare: { password: REDACTED, kept: "yes" },
    });
  });

  it("redacts what an object's toJSON answers with", () => {
    const value = { toJSON: () => ({ token: "SYNTHETIC", kept: "yes" }) };
    expect(redactor.redact({ value })).toEqual({
      value: { token: REDACTED, kept: "yes" },
    });
  });

  it("reduces an error to where it was created, wherever it is", () => {
    const error = Object.assign(new Error("holds SYNTHETIC_API_KEY"), {
      response: "SYNTHETIC_API_KEY",
    });
    const redacted = redactor.redact({ deep: [{ cause: error }] });
    expect(JSON.stringify(redacted)).not.toContain("SYNTHETIC_API_KEY");
    expect(redacted).toEqual({
      deep: [{ cause: { frames: expect.any(Array) as unknown } }],
    });
  });

  it("stops at a value that holds itself, and at one it cannot read", () => {
    const loop: Record<string, unknown> = { kept: "yes" };
    loop["self"] = loop;
    expect(redactor.redact(loop)).toEqual({ kept: "yes", self: "[Circular]" });

    const unreadable = {
      get value(): string {
        throw new Error("no");
      },
    };
    expect(redactor.redact({ unreadable, kept: "yes" })).toEqual({
      unreadable: REDACTED,
      kept: "yes",
    });
  });

  it("keeps a key named __proto__ as a field", () => {
    const parsed = JSON.parse(
      '{"__proto__":{"password":"x","kept":"yes"}}',
    ) as unknown;
    expect(JSON.stringify(redactor.redact(parsed))).toBe(
      `{"__proto__":{"password":"${REDACTED}","kept":"yes"}}`,
    );
  });
});
