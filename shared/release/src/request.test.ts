import { describe, expect, it } from "vitest";

import { RELEASE_ID, REQUEST } from "../test/helpers.ts";
import {
  encodeReleaseMessage,
  parseReleaseMessage,
  parseReleaseRequest,
  releaseGroup,
} from "./request.ts";

const MESSAGE = {
  environment: "development",
  domain: "example",
  id: RELEASE_ID,
};

describe("parseReleaseMessage", () => {
  it("reads what the pipeline API wrote", () => {
    expect(parseReleaseMessage(encodeReleaseMessage(MESSAGE))).toEqual(MESSAGE);
  });

  it("writes the key alone, whatever else the value holds", () => {
    expect(
      JSON.parse(encodeReleaseMessage({ ...MESSAGE, ...REQUEST })),
    ).toEqual(MESSAGE);
  });

  it.each<[string, string]>([
    ["text that isn't JSON", "release example"],
    ["a list", "[]"],
    ["null", "null"],
    ["a field it doesn't know", JSON.stringify({ ...MESSAGE, sha256: "a" })],
    ["no ID", JSON.stringify({ ...MESSAGE, id: undefined })],
    [
      "an ID that isn't a release's",
      JSON.stringify({
        ...MESSAGE,
        id: "00000000-0000-4000-8000-000000000000",
      }),
    ],
    [
      "an environment's name with a path in it",
      JSON.stringify({ ...MESSAGE, environment: "development/../staging" }),
    ],
    ["a domain that isn't a name", JSON.stringify({ ...MESSAGE, domain: "" })],
    ["a number for a name", JSON.stringify({ ...MESSAGE, domain: 1 })],
  ])("refuses %s", (_, text) => {
    expect(parseReleaseMessage(text)).toBeUndefined();
  });
});

describe("parseReleaseRequest", () => {
  it("reads a request, with or without the run's ID and commit", () => {
    expect(parseReleaseRequest(REQUEST)).toEqual(REQUEST);
    const bare = { ...REQUEST, runId: undefined, commit: undefined };
    expect(parseReleaseRequest(bare)).toEqual(bare);
  });

  it.each<[string, unknown]>([
    ["a field it doesn't know", { ...REQUEST, memory: 1024 }],
    [
      "a hash in capitals",
      { ...REQUEST, sha256: REQUEST.sha256.toUpperCase() },
    ],
    ["no version", { ...REQUEST, version: undefined }],
    ["a version that isn't one", { ...REQUEST, version: "1.4" }],
    ["no S3 version", { ...REQUEST, versionId: undefined }],
    ["an S3 version with a space in it", { ...REQUEST, versionId: "a b" }],
    ["a run's ID that isn't digits", { ...REQUEST, runId: "1a" }],
    ["a commit that isn't a hash", { ...REQUEST, commit: "main" }],
  ])("refuses %s", (_, value) => {
    expect(parseReleaseRequest(value)).toBeUndefined();
  });
});

describe("releaseGroup", () => {
  it("is one group for each domain in each environment", () => {
    expect(releaseGroup(REQUEST)).toBe("development.example");
    expect(releaseGroup({ ...REQUEST, environment: "staging" })).toBe(
      "staging.example",
    );
  });
});
