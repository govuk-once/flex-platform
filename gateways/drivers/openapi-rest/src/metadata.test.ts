import { describe, expect, it } from "vitest";

import { compileMetadata, metadataProblems } from "./metadata.ts";

describe("compileMetadata", () => {
  it("reads each name with the header it comes from, as Headers compares them, and its type", () => {
    expect(
      compileMetadata({
        upstreamRequestId: {
          header: "X-DVLA-Request-Id",
          schema: { type: "string", maxLength: 128 },
        },
        remaining: {
          header: "X-RateLimit-Remaining",
          schema: { type: "integer" },
        },
      }),
    ).toEqual([
      {
        name: "upstreamRequestId",
        header: "x-dvla-request-id",
        type: "string",
      },
      { name: "remaining", header: "x-ratelimit-remaining", type: "integer" },
    ]);
    expect(compileMetadata(undefined)).toEqual([]);
  });

  it("refuses to start on metadata it cannot read, saying everything wrong with it", () => {
    const malformed = {
      noHeader: { schema: { type: "string" } },
      badHeader: { header: "not a header", schema: { type: "string" } },
      notScalar: { header: "x-trace", schema: { type: "object" } },
      noSchema: { header: "x-other" },
    };

    expect(metadataProblems(malformed)).toHaveLength(4);
    expect(metadataProblems(malformed)[0]).toBe(
      'Driver metadata "noHeader" must name the response header it is read from',
    );
    expect(metadataProblems(malformed)[2]).toBe(
      'Driver metadata "notScalar" must have a schema of one type, of string, number, integer, boolean',
    );
    expect(() => compileMetadata(malformed)).toThrow(TypeError);
    expect(metadataProblems("nope")).toEqual([
      "Driver metadata must be an object",
    ]);
  });
});
