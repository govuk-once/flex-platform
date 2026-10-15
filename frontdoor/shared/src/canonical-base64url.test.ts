import { describe, expect, it } from "vitest";

import { isCanonicalBase64url } from "./canonical-base64url.ts";

describe("isCanonicalBase64url", () => {
  it.each([[[1]], [[1, 2]], [[1, 2, 3]], [[255, 255]], [[255, 255, 255, 255]]])(
    "accepts the encoding of %j",
    (bytes) => {
      expect(
        isCanonicalBase64url(Buffer.from(bytes).toString("base64url")),
      ).toBe(true);
    },
  );

  // "AQ" is [1]. "AR" to "Af" decode to it too, with spare bits set; so do "AQE" and "AQF" to
  // "AQH" for [1, 1].
  it.each([["AR"], ["Af"], ["AQF"], ["AQH"]])(
    "refuses %j, whose spare bits are set",
    (segment) => {
      expect(Buffer.from(segment, "base64url")).toEqual(
        Buffer.from(segment.length === 2 ? [1] : [1, 1]),
      );
      expect(isCanonicalBase64url(segment)).toBe(false);
    },
  );

  it.each([[""], ["A"], ["AQ=="], ["A+"], ["A/"], ["A Q"]])(
    "refuses %j, which isn't unpadded base64url",
    (segment) => {
      expect(isCanonicalBase64url(segment)).toBe(false);
    },
  );
});
