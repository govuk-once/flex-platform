import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TestHeaders } from "../../test/helpers.ts";
import {
  CONFIG,
  NOW,
  REQUEST_ID,
  token,
  viewerRequestEvent,
} from "../../test/helpers.ts";
import { traceIdFor } from "./trace-id.ts";
import type { CloudFrontResponse } from "./types.ts";
import { viewerRequest } from "./viewer-request.ts";

const TRACE_ID = traceIdFor(REQUEST_ID, NOW);
const AUTHORIZATION = `Bearer ${token()}`;

let logLines: string[];

beforeEach(() => {
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logLines.push(line);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function run(...args: Parameters<typeof viewerRequestEvent>) {
  return viewerRequest(viewerRequestEvent(...args), CONFIG, NOW);
}

function loggedEvents(): unknown[] {
  return logLines.map((line) => JSON.parse(line) as unknown);
}

function telemetry(event: string, reason?: string) {
  return {
    level: "INFO",
    message: "telemetry",
    telemetry: {
      event,
      details: {
        traceId: TRACE_ID,
        requestId: REQUEST_ID,
        ...(reason === undefined ? {} : { reason }),
      },
    },
  };
}

function rejection(
  statusCode: number,
  message: string,
  type: string,
): CloudFrontResponse {
  return {
    statusCode,
    headers: {
      "content-type": { value: "application/json" },
      "x-rejected-by": { value: "cloudfront-function" },
      "x-correlation-id": { value: TRACE_ID },
    },
    body: { encoding: "text", data: JSON.stringify({ message, type }) },
  };
}

const UNAUTHORIZED = rejection(401, "Unauthorized", "auth_error");
const NOT_FOUND = rejection(404, "Not Found", "not_found");
const UNSUPPORTED = rejection(
  415,
  "Unsupported Media Type",
  "unsupported_media_type",
);

describe("viewerRequest", () => {
  // Everything CloudFront sends survives, apart from the headers the function owns.
  it("passes a valid request on unchanged, under a trace of its own", () => {
    const event = viewerRequestEvent({
      headers: {
        authorization: AUTHORIZATION,
        accept: ["application/json", "text/html"],
        "user-agent": "GOV.UK app",
      },
    });
    const before = structuredClone(event.request);

    const result = viewerRequest(event, CONFIG, NOW);

    expect(result).toEqual({
      ...before,
      headers: {
        ...before.headers,
        "x-amzn-trace-id": { value: `Root=${TRACE_ID}` },
        "x-correlation-id": { value: TRACE_ID },
      },
    });
    expect(loggedEvents()).toEqual([telemetry("cff_token_validated")]);
  });

  // A caller who chose the trace could tie requests together, or force every one to be sampled.
  it("replaces or removes any trace context the caller sends", () => {
    const result = run({
      headers: {
        authorization: AUTHORIZATION,
        "x-amzn-trace-id": "Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1",
        "x-correlation-id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        traceparent: "00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-01",
        tracestate: "vendor=value",
      },
    });

    expect(result.headers).toEqual({
      authorization: { value: AUTHORIZATION },
      "x-amzn-trace-id": { value: `Root=${TRACE_ID}` },
      "x-correlation-id": { value: TRACE_ID },
    });
  });

  it("removes every x-flex- header a caller sends", () => {
    const result = run({
      headers: {
        authorization: AUTHORIZATION,
        "x-flex-secure": "forged",
        "x-flex-anything": "forged",
        "x-flexible": "kept",
      },
    });

    expect(Object.keys(result.headers).sort()).toEqual([
      "authorization",
      "x-amzn-trace-id",
      "x-correlation-id",
      "x-flexible",
    ]);
  });

  // Each outcome's whole response, and one log line naming it, with nothing from the request.
  it.each<{
    case: string;
    uri?: string;
    method?: string;
    headers: TestHeaders;
    response: CloudFrontResponse;
    event: string;
    reason?: string;
  }>([
    {
      case: "no token",
      headers: {},
      response: UNAUTHORIZED,
      event: "cff_token_missing",
      reason: "no-header",
    },
    {
      case: "a malformed token",
      headers: { authorization: `${AUTHORIZATION}.c2VjcmV0LXNlZ21lbnQ` },
      response: UNAUTHORIZED,
      event: "cff_token_invalid",
      reason: "segments",
    },
    {
      case: "an expired token",
      headers: { authorization: `Bearer ${token({}, { exp: NOW })}` },
      response: UNAUTHORIZED,
      event: "cff_token_expired",
      reason: "expired",
    },
    {
      case: "a repeated authorization header",
      headers: { authorization: [AUTHORIZATION, "Bearer forged"] },
      response: UNAUTHORIZED,
      event: "cff_token_invalid",
      reason: "repeated",
    },
    {
      case: "no token and no valid path",
      uri: "/nowhere",
      headers: {},
      response: UNAUTHORIZED,
      event: "cff_token_missing",
      reason: "no-header",
    },
    {
      case: "a path without a valid domain name",
      uri: "/app/udp.evil.example/v1",
      headers: { authorization: AUTHORIZATION },
      response: NOT_FOUND,
      event: "cff_path_rejected",
    },
    {
      case: "a body that isn't JSON",
      method: "POST",
      headers: {
        authorization: AUTHORIZATION,
        "content-length": "12",
        "content-type": "text/plain",
      },
      response: UNSUPPORTED,
      event: "cff_content_type_rejected",
    },
  ])("answers $case", ({ uri, method, headers, response, event, reason }) => {
    const result = run({
      headers,
      ...(uri === undefined ? {} : { uri }),
      ...(method === undefined ? {} : { method }),
    });

    expect(result).toEqual(response);
    expect(loggedEvents()).toEqual([telemetry(event, reason)]);
    expect(logLines.join("")).not.toContain(token());
  });

  describe("a request with a body", () => {
    function post(headers: TestHeaders) {
      return run({
        method: "POST",
        headers: { authorization: AUTHORIZATION, ...headers },
      });
    }

    it.each<[string, TestHeaders]>([
      [
        "it's text, by content length",
        { "content-length": "12", "content-type": "text/plain" },
      ],
      [
        "it's text, by chunked transfer",
        { "transfer-encoding": "chunked", "content-type": "text/plain" },
      ],
      ["it has no content type", { "content-length": "12" }],
      [
        "its content type is repeated",
        {
          "content-length": "12",
          "content-type": ["application/json", "text/plain"],
        },
      ],
      [
        "its content length is repeated",
        { "content-length": ["12", "0"], "content-type": "application/json" },
      ],
      [
        "its transfer encoding is repeated",
        {
          "transfer-encoding": ["chunked", "identity"],
          "content-type": "application/json",
        },
      ],
      [
        "it's a JSON look-alike",
        { "content-length": "12", "content-type": "application/jsonp" },
      ],
      [
        "it's another JSON type",
        {
          "content-length": "12",
          "content-type": "application/json-patch+json",
        },
      ],
    ])("refuses it when %s", (_, headers) => {
      expect(post(headers)).toEqual(UNSUPPORTED);
    });

    it.each([
      "application/json",
      "application/json; charset=utf-8",
      "Application/JSON",
    ])("passes with content type %s", (contentType) => {
      const result = post({
        "content-length": "12",
        "content-type": contentType,
      });

      expect(result).not.toHaveProperty("statusCode");
    });

    it("passes JSON that announces no length, as HTTP/2 and HTTP/3 allow", () => {
      const result = post({ "content-type": "application/json" });

      expect(result).not.toHaveProperty("statusCode");
    });
  });

  describe("a method that carries a body", () => {
    it.each(["PATCH", "POST", "PUT"])(
      "refuses %s without JSON, even when no body is announced",
      (method) => {
        const result = run({
          method,
          headers: { authorization: AUTHORIZATION },
        });

        expect(result).toEqual(UNSUPPORTED);
      },
    );
  });

  describe("any other method", () => {
    it.each(["DELETE", "GET", "HEAD"])(
      "passes %s without a body whatever its content type",
      (method) => {
        const result = run({
          method,
          headers: { authorization: AUTHORIZATION, "content-length": "0" },
        });

        expect(result).not.toHaveProperty("statusCode");
      },
    );

    it("refuses a DELETE announcing a body that isn't JSON", () => {
      const result = run({
        method: "DELETE",
        headers: {
          authorization: AUTHORIZATION,
          "content-length": "12",
          "content-type": "text/plain",
        },
      });

      expect(result).toEqual(UNSUPPORTED);
    });
  });
});
