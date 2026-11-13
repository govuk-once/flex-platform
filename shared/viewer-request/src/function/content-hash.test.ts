import { describe, expect, it } from "vitest";

import {
  CONTENT_HASH,
  pipelineHeaders,
  type TestHeaders,
  viewerRequestEvent,
} from "../../test/helpers.ts";
import { hasContentHash } from "./content-hash.ts";

function check(headers: TestHeaders): boolean {
  return hasContentHash(viewerRequestEvent({ headers }).request);
}

describe("hasContentHash", () => {
  it("accepts a SHA-256 in lowercase hex, sent once", () => {
    expect(check(pipelineHeaders())).toBe(true);
  });

  it.each<[string, TestHeaders]>([
    ["no header", {}],
    ["an empty header", { "x-amz-content-sha256": "" }],
    // Lambda function URLs take no unsigned payload.
    ["an unsigned payload", { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" }],
    // SigV4 writes the hash in lowercase, so any other case is another signature.
    ["uppercase hex", { "x-amz-content-sha256": CONTENT_HASH.toUpperCase() }],
    ["a shorter hash", { "x-amz-content-sha256": CONTENT_HASH.slice(1) }],
    ["a longer hash", { "x-amz-content-sha256": `${CONTENT_HASH}0` }],
    [
      "a character that isn't hex",
      { "x-amz-content-sha256": `${CONTENT_HASH.slice(1)}g` },
    ],
    [
      "a hash in base64",
      {
        "x-amz-content-sha256": "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      },
    ],
    ["a space before it", { "x-amz-content-sha256": ` ${CONTENT_HASH}` }],
    [
      "a hash sent twice",
      { "x-amz-content-sha256": [CONTENT_HASH, CONTENT_HASH] },
    ],
  ])("refuses %s", (_, headers) => {
    expect(check(headers)).toBe(false);
  });
});
