import { describe, expect, it } from "vitest";

import type { CloudFrontRequest, FieldValue } from "./event.ts";
import { isJsonRequest } from "./json-request.ts";

function request(
  method: string,
  headers: Record<string, string | readonly string[]> = {},
): CloudFrontRequest {
  const fields: Record<string, FieldValue> = {};
  for (const [name, value] of Object.entries(headers)) {
    fields[name] =
      typeof value === "string"
        ? { value }
        : {
            value: value[0] ?? "",
            multiValue: value.map((each) => ({ value: each })),
          };
  }
  return { method, uri: "/", querystring: {}, headers: fields, cookies: {} };
}

describe("isJsonRequest", () => {
  it.each(["DELETE", "GET"])("passes a %s with no body", (method) => {
    expect(isJsonRequest(request(method))).toBe(true);
    expect(isJsonRequest(request(method, { "content-length": "0" }))).toBe(
      true,
    );
  });

  it.each([
    "application/json",
    "application/json; charset=utf-8",
    "APPLICATION/JSON",
    "application/json ;charset=utf-8",
  ])("passes a POST announced as %s", (contentType) => {
    expect(
      isJsonRequest(request("POST", { "content-type": contentType })),
    ).toBe(true);
  });

  // HTTP/2 and HTTP/3 needn't announce a body, so the method alone demands JSON.
  it.each(["PATCH", "POST", "PUT"])(
    "refuses a %s that isn't announced as JSON, with or without a length",
    (method) => {
      expect(isJsonRequest(request(method))).toBe(false);
      expect(
        isJsonRequest(request(method, { "content-type": "text/plain" })),
      ).toBe(false);
      expect(
        isJsonRequest(request(method, { "content-type": "application/jsonp" })),
      ).toBe(false);
    },
  );

  it.each([
    ["a length", { "content-length": "12" }],
    ["chunks", { "transfer-encoding": "chunked" }],
  ])("refuses a GET announcing a body by %s that isn't JSON", (_, headers) => {
    expect(isJsonRequest(request("GET", headers))).toBe(false);
    expect(
      isJsonRequest(
        request("GET", { ...headers, "content-type": "application/json" }),
      ),
    ).toBe(true);
  });

  it.each(["content-length", "content-type", "transfer-encoding"])(
    "refuses a repeated %s, whatever it says",
    (name) => {
      expect(
        isJsonRequest(
          request("POST", {
            "content-type": "application/json",
            [name]: ["application/json", "application/json"],
          }),
        ),
      ).toBe(false);
    },
  );
});
