import { describe, expect, it } from "vitest";

import {
  methodNotAllowed,
  notFound,
  unauthorized,
  unsupportedMediaType,
} from "./responses.ts";

const TRACE_ID = "1-6b49d200-0123456789abcdef01234567";

const HEADERS = {
  "content-type": { value: "application/json" },
  "x-rejected-by": { value: "cloudfront-function" },
  "x-correlation-id": { value: TRACE_ID },
};

function body(message: string, type: string) {
  return { encoding: "text", data: JSON.stringify({ message, type }) };
}

describe("a refusal", () => {
  it.each([
    [unauthorized, 401, "Unauthorized", "auth_error"],
    [notFound, 404, "Not found", "client_error"],
    [unsupportedMediaType, 415, "Unsupported media type", "client_error"],
  ] as const)(
    "%o answers %i in the platform's shape",
    (refuse, statusCode, message, type) => {
      expect(refuse(TRACE_ID)).toEqual({
        statusCode,
        headers: HEADERS,
        body: body(message, type),
      });
    },
  );

  it("names the methods a 405 would have allowed", () => {
    expect(methodNotAllowed(TRACE_ID, ["GET", "POST"])).toEqual({
      statusCode: 405,
      headers: { ...HEADERS, allow: { value: "GET, POST" } },
      body: body("Method not allowed", "client_error"),
    });
  });
});
