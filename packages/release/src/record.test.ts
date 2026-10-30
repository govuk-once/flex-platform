import { describe, expect, it } from "vitest";

import { parseRecord, releasedBetween, serializeRecord } from "./record.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const release = (version: string) => ({ version, digest: DIGEST });

describe("the record's file", () => {
  it("is written one package to a line, in order, and read back as written", () => {
    const record = new Map([
      ["@govuk-once/b", release("0.2.0")],
      ["@govuk-once/a", release("0.1.0")],
    ]);
    const text = serializeRecord(record);

    expect(text).toBe(
      `{\n  "@govuk-once/a": { "version": "0.1.0", "digest": "${DIGEST}" },\n  "@govuk-once/b": { "version": "0.2.0", "digest": "${DIGEST}" }\n}\n`,
    );
    expect(parseRecord(text)).toEqual(record);
  });

  it("is an empty object before anything is released", () => {
    expect(serializeRecord(new Map())).toBe("{}\n");
    expect(parseRecord("{}\n").size).toBe(0);
  });

  it.each([
    ["a list", "[]"],
    [
      "an entry without a digest",
      '{ "@govuk-once/a": { "version": "0.1.0" } }',
    ],
    [
      "an entry with more than its version and digest",
      `{ "@govuk-once/a": { "version": "0.1.0", "digest": "${DIGEST}", "at": 1 } }`,
    ],
    [
      "a digest of another form",
      '{ "@govuk-once/a": { "version": "0.1.0", "digest": "sha512-x" } }',
    ],
    [
      "a candidate's version",
      `{ "@govuk-once/a": { "version": "0.1.0-rc.1", "digest": "${DIGEST}" } }`,
    ],
  ])("refuses %s", (_case, text) => {
    expect(() => parseRecord(text)).toThrow();
  });
});

describe("releasedBetween", () => {
  it("names the packages added or moved to a new version", () => {
    const before = new Map([
      ["@govuk-once/a", release("0.1.0")],
      ["@govuk-once/b", release("0.1.0")],
    ]);
    const after = new Map([
      ["@govuk-once/a", release("0.1.0")],
      ["@govuk-once/b", release("0.1.1")],
      ["@govuk-once/c", release("0.1.0")],
    ]);

    expect(releasedBetween(before, after)).toEqual([
      "@govuk-once/b",
      "@govuk-once/c",
    ]);
  });

  it("refuses a version moved back, or a package removed", () => {
    const before = new Map([["@govuk-once/a", release("0.2.0")]]);

    expect(() =>
      releasedBetween(before, new Map([["@govuk-once/a", release("0.1.9")]])),
    ).toThrow("moves @govuk-once/a back from 0.2.0 to 0.1.9.");
    expect(() => releasedBetween(before, new Map())).toThrow(
      "no longer holds @govuk-once/a.",
    );
  });

  it("refuses a digest changed under the same version", () => {
    const before = new Map([["@govuk-once/a", release("0.1.0")]]);
    const after = new Map([
      [
        "@govuk-once/a",
        { version: "0.1.0", digest: `sha256:${"b".repeat(64)}` },
      ],
    ]);

    expect(() => releasedBetween(before, after)).toThrow(
      "changes what @govuk-once/a 0.1.0 released. Release a new version instead.",
    );
  });
});
