import { describe, expect, it } from "vitest";

import { BUNDLE, functionUrlEvent, UPLOAD } from "../../test/helpers.ts";
import { MAX_BUNDLE_BYTES, releaseOf, uploadOf } from "./bundle.ts";

function sent(body: unknown) {
  return uploadOf(functionUrlEvent({ body: JSON.stringify(body) }));
}

describe("uploadOf", () => {
  it("reads a bundle's version, hash and length from the body", () => {
    expect(uploadOf(functionUrlEvent())).toEqual(UPLOAD);
  });

  it("reads a body Lambda gives in base64", () => {
    expect(
      uploadOf(
        functionUrlEvent({
          body: Buffer.from(JSON.stringify(UPLOAD)).toString("base64"),
          isBase64Encoded: true,
        }),
      ),
    ).toEqual(UPLOAD);
  });

  it("takes a bundle of one byte, and of the most Lambda unzips", () => {
    expect(sent({ ...UPLOAD, size: 1 })).toEqual({ ...UPLOAD, size: 1 });
    expect(sent({ ...UPLOAD, size: MAX_BUNDLE_BYTES })).toEqual({
      ...UPLOAD,
      size: MAX_BUNDLE_BYTES,
    });
  });

  it.each([
    ["no body", null],
    ["an empty body", ""],
    ["text that isn't JSON", "sha256=abc"],
    ["a list", JSON.stringify([UPLOAD])],
    ["null", "null"],
    ["a string", JSON.stringify("bundle")],
    ["a field it doesn't know", JSON.stringify({ ...UPLOAD, key: "a/b.zip" })],
    ["a body far longer than a bundle's", `${" ".repeat(2000)}{}`],
  ])("refuses %s as no body of a bundle's", (_, body) => {
    expect(uploadOf(functionUrlEvent({ body }))).toBe("body");
  });

  // What a version may be is `isBundleVersion`'s to say, and tested there.
  it.each([
    ["none", undefined],
    ["one with a v", "v1.4.2"],
    ["a pre-release", "1.4.2-rc.1"],
    ["a number", 1.4],
  ])("refuses a version that is %s", (_, version) => {
    expect(sent({ ...UPLOAD, version })).toBe("version");
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
    expect(sent({ ...UPLOAD, sha256 })).toBe("sha256");
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
    expect(sent({ ...UPLOAD, size })).toBe("size");
  });

  // `JSON.parse` makes `__proto__` an own field, so it is refused as any unknown field is, and a
  // field the prototype answers to is not read from it.
  it("reads no field from the prototype", () => {
    expect(
      uploadOf(
        functionUrlEvent({
          body: `{"__proto__":${JSON.stringify(UPLOAD)}}`,
        }),
      ),
    ).toBe("body");
    expect(sent({ version: UPLOAD.version, size: BUNDLE.size })).toBe("sha256");
  });
});

describe("releaseOf", () => {
  function asked(body: unknown) {
    return releaseOf(functionUrlEvent({ body: JSON.stringify(body) }));
  }

  it("reads the hash of the bundle to release", () => {
    expect(asked({ sha256: BUNDLE.sha256 })).toEqual({ sha256: BUNDLE.sha256 });
  });

  it.each([
    ["no body", null],
    ["text that isn't JSON", "release"],
    ["a list", JSON.stringify([{ sha256: BUNDLE.sha256 }])],
    // A release names its bundle by hash alone. The size was the upload's to say.
    ["a field it doesn't know", JSON.stringify(BUNDLE)],
    ["a body far longer than a release's", `${" ".repeat(2000)}{}`],
  ])("refuses %s as no body of a release's", (_, body) => {
    expect(releaseOf(functionUrlEvent({ body }))).toBe("body");
  });

  it.each([
    ["none", undefined],
    ["one in capitals", BUNDLE.sha256.toUpperCase()],
    ["a path", `../${BUNDLE.sha256.slice(3)}`],
  ])("refuses a hash that is %s", (_, sha256) => {
    expect(asked({ sha256 })).toBe("sha256");
  });
});
