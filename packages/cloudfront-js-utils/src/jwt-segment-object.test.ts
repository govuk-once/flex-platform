import { describe, expect, it } from "vitest";

import { jwtSegmentObject } from "./jwt-segment-object.ts";

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("jwtSegmentObject", () => {
  it("decodes the object a segment holds, whatever its length leaves spare", () => {
    for (const value of [{}, { a: 1 }, { alg: "RS256" }, { sub: "ü-_?>" }]) {
      expect(jwtSegmentObject(segment(value))).toEqual(value);
    }
  });

  it.each([
    ["a missing segment", undefined],
    ["an empty segment", ""],
    ["padding", `${segment({ a: 1 })}=`],
    ["standard base64's characters", "eyJhIjoiPz4/In0+"],
    ["text that isn't JSON", Buffer.from("not json").toString("base64url")],
    ["an array", segment([1, 2])],
    ["a string", segment("text")],
    ["a number", segment(1)],
    ["null", segment(null)],
  ])("is undefined for %s", (_, value) => {
    expect(jwtSegmentObject(value)).toBeUndefined();
  });

  // A decoder ignores a final character's spare bits, so one object could be written several
  // ways. Only the way an encoder writes it is accepted.
  it("is undefined for a segment whose spare bits aren't zero", () => {
    const canonical = segment({ a: 1 });
    expect(canonical.length % 4).toBe(2);
    const last = canonical.charAt(canonical.length - 1);
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const altered =
      canonical.slice(0, -1) + alphabet.charAt(alphabet.indexOf(last) + 1);

    expect(Buffer.from(altered, "base64url").toString()).toBe('{"a":1}');
    expect(jwtSegmentObject(altered)).toBeUndefined();
  });
});
