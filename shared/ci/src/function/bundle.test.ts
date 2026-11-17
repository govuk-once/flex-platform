import { describe, expect, it } from "vitest";

import { BUNDLE, functionUrlEvent } from "../../test/helpers.ts";
import { bundleKey, bundleOf, MAX_BUNDLE_BYTES } from "./bundle.ts";

function sent(body: unknown) {
  return bundleOf(functionUrlEvent({ body: JSON.stringify(body) }));
}

describe("bundleOf", () => {
  it("reads a bundle's hash and length from the body", () => {
    expect(bundleOf(functionUrlEvent())).toEqual(BUNDLE);
  });

  it("reads a body Lambda gives in base64", () => {
    expect(
      bundleOf(
        functionUrlEvent({
          body: Buffer.from(JSON.stringify(BUNDLE)).toString("base64"),
          isBase64Encoded: true,
        }),
      ),
    ).toEqual(BUNDLE);
  });

  it("takes a bundle of one byte, and of the most Lambda unzips", () => {
    expect(sent({ ...BUNDLE, size: 1 })).toEqual({ ...BUNDLE, size: 1 });
    expect(sent({ ...BUNDLE, size: MAX_BUNDLE_BYTES })).toEqual({
      ...BUNDLE,
      size: MAX_BUNDLE_BYTES,
    });
  });

  it.each([
    ["no body", null],
    ["an empty body", ""],
    ["text that isn't JSON", "sha256=abc"],
    ["a list", JSON.stringify([BUNDLE])],
    ["null", "null"],
    ["a string", JSON.stringify("bundle")],
    ["a field it doesn't know", JSON.stringify({ ...BUNDLE, key: "a/b.zip" })],
    ["a body far longer than a bundle's", `${" ".repeat(2000)}{}`],
  ])("refuses %s as no body of a bundle's", (_, body) => {
    expect(bundleOf(functionUrlEvent({ body }))).toBe("body");
  });

  it.each([
    ["none", undefined],
    ["one in capitals", BUNDLE.sha256.toUpperCase()],
    ["one too short", BUNDLE.sha256.slice(1)],
    ["one too long", `${BUNDLE.sha256}0`],
    ["one in base64", "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="],
    ["a path", `../${BUNDLE.sha256.slice(3)}`],
    ["a number", 9],
  ])("refuses a hash that is %s", (_, sha256) => {
    expect(sent({ ...BUNDLE, sha256 })).toBe("sha256");
  });

  it.each([
    ["none", undefined],
    ["zero", 0],
    ["negative", -4096],
    ["a fraction", 4096.5],
    ["a string", "4096"],
    ["more than Lambda unzips", MAX_BUNDLE_BYTES + 1],
    ["beyond a safe integer", 2 ** 60],
  ])("refuses a length that is %s", (_, size) => {
    expect(sent({ ...BUNDLE, size })).toBe("size");
  });

  // `JSON.parse` makes `__proto__` an own field, so it is refused as any unknown field is, and a
  // field the prototype answers to is not read from it.
  it("reads no field from the prototype", () => {
    expect(
      bundleOf(
        functionUrlEvent({
          body: `{"__proto__":${JSON.stringify(BUNDLE)}}`,
        }),
      ),
    ).toBe("body");
    expect(sent({ size: BUNDLE.size })).toBe("sha256");
  });
});

describe("bundleKey", () => {
  it("puts a bundle under its domain, named by its hash", () => {
    expect(bundleKey("example", BUNDLE.sha256)).toBe(
      `example/bundle/${BUNDLE.sha256}.zip`,
    );
  });
});
