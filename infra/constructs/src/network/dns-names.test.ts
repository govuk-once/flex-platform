import { describe, expect, it } from "vitest";

import { dnsAllowlist, exactHostname } from "./dns-names.ts";

describe("exactHostname", () => {
  it.each([
    ["api.example.com", "api.example.com"],
    ["API.Example.COM", "api.example.com"],
    ["api.example.com.", "api.example.com"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["a-b.c1.example", "a-b.c1.example"],
  ])("accepts %j as %j", (entry, name) => {
    expect(exactHostname(entry)).toBe(name);
  });

  it.each([
    ["https://api.example.com", "is a URL"],
    ["api.example.com/v1", "has a path"],
    ["api.example.com?x=1", "has a path"],
    ["user@api.example.com", "has a path, query or user"],
    ["api.example.com:443", "has a port"],
    ["[2001:db8::1]", "has a port or is an IPv6 address"],
    ["2001:db8::1", "has a port or is an IPv6 address"],
    ["192.0.2.1", "is an IP address"],
    ["*.example.com", "is a wildcard"],
    ["*.execute-api.eu-west-2.amazonaws.com", "is a wildcard"],
    ["*", "is a wildcard"],
    ["api .example.com", "contains whitespace"],
    [" api.example.com", "contains whitespace"],
    ["", "is empty"],
    ["localhost", "at least two labels"],
    ["-api.example.com", '"-api" is not a valid label'],
    ["api-.example.com", '"api-" is not a valid label'],
    ["api..example.com", '"" is not a valid label'],
    ["api_v1.example.com", '"api_v1" is not a valid label'],
    ["bücher.example", '"bücher" is not a valid label'],
    [`${"a".repeat(64)}.example`, "is not a valid label"],
    [`${"a.".repeat(127)}example`, "longer than 253 characters"],
  ])("refuses %j", (entry, why) => {
    expect(() => exactHostname(entry)).toThrow(why);
  });
});

describe("dnsAllowlist", () => {
  it("normalises, removes repeats and sorts, whatever order the names came in", () => {
    const forwards = dnsAllowlist([
      "b.example.com",
      "A.example.com",
      "a.example.com.",
    ]);

    expect(forwards).toEqual(["a.example.com", "b.example.com"]);
    expect(
      dnsAllowlist(["a.example.com", "b.example.com"].toReversed()),
    ).toEqual(forwards);
  });

  it("refuses the whole list for one unsafe entry", () => {
    expect(() => dnsAllowlist(["a.example.com", "a.example.com:443"])).toThrow(
      "has a port",
    );
  });
});
