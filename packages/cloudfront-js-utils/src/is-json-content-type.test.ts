import { describe, expect, it } from "vitest";

import { isJsonContentType } from "./is-json-content-type.ts";

describe("isJsonContentType", () => {
  it.each([
    "application/json",
    "APPLICATION/JSON",
    "application/json; charset=utf-8",
    "application/json;charset=utf-8",
    "application/json ",
  ])("takes %j as JSON", (value) => {
    expect(isJsonContentType(value)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "text/plain",
    "application/jsonp",
    "application/json-patch+json",
    "text/plain, application/json",
    " application/json",
  ])("refuses %j", (value) => {
    expect(isJsonContentType(value)).toBe(false);
  });
});
