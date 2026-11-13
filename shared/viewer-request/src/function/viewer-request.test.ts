import type { CloudFrontResponse } from "@repo/cloudfront-function";
import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TestHeaders } from "../../test/helpers.ts";
import {
  CONFIG,
  CONTENT_HASH,
  NOW,
  pipelineHeaders,
  REQUEST_ID,
  token,
  viewerRequestEvent,
} from "../../test/helpers.ts";
import { viewerRequest } from "./viewer-request.ts";

const TRACE_ID = traceIdFor(REQUEST_ID, NOW);

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
  extraHeaders: CloudFrontResponse["headers"] = {},
): CloudFrontResponse {
  return {
    statusCode,
    headers: {
      "content-type": { value: "application/json" },
      "x-rejected-by": { value: "cloudfront-function" },
      "x-correlation-id": { value: TRACE_ID },
      ...extraHeaders,
    },
    body: { encoding: "text", data: JSON.stringify({ message, type }) },
  };
}

const METHOD_NOT_ALLOWED = rejection(
  405,
  "Method not allowed",
  "client_error",
  { allow: { value: "POST" } },
);
const BAD_REQUEST = rejection(400, "Bad request", "client_error");
const UNAUTHORIZED = rejection(401, "Unauthorized", "auth_error");
const NOT_FOUND = rejection(404, "Not found", "client_error");
const UNSUPPORTED = rejection(415, "Unsupported media type", "client_error");

describe("viewerRequest", () => {
  // Everything CloudFront sends survives, the token included, apart from the headers the
  // function owns.
  it("passes a pipeline's request on unchanged, under an ID of its own", () => {
    const event = viewerRequestEvent({
      headers: pipelineHeaders({
        accept: "application/json",
        "content-length": "64",
        "user-agent": "a pipeline",
      }),
    });
    const before = structuredClone(event.request);

    const result = viewerRequest(event, CONFIG, NOW);

    expect(result).toEqual({
      ...before,
      headers: {
        ...before.headers,
        "x-correlation-id": { value: TRACE_ID },
      },
    });
    expect(loggedEvents()).toEqual([
      telemetry("viewer_request_token_validated"),
    ]);
    expect(logLines.join("")).not.toContain(token());
  });

  // A caller who chose the trace could tie requests together, or force every one to be sampled.
  it("replaces or removes any trace context the caller sends", () => {
    const result = run({
      headers: pipelineHeaders({
        "x-amzn-trace-id": "Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1",
        "x-correlation-id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        traceparent: "00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-01",
        tracestate: "vendor=value",
      }),
    });

    expect(result.headers).toEqual({
      "x-flex-ci-token": { value: token() },
      "content-type": { value: "application/json" },
      "x-amz-content-sha256": { value: CONTENT_HASH },
      "x-correlation-id": { value: TRACE_ID },
    });
  });

  it("removes every x-flex- header a caller sends but the token's", () => {
    const result = run({
      headers: pipelineHeaders({
        "x-flex-secure": "forged",
        "x-flex-ci-token-2": "forged",
        "x-flexible": "kept",
      }),
    });

    expect(Object.keys(result.headers).sort()).toEqual([
      "content-type",
      "x-amz-content-sha256",
      "x-correlation-id",
      "x-flex-ci-token",
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
      headers: pipelineHeaders({ "x-flex-ci-token": "" }),
      response: UNAUTHORIZED,
      event: "viewer_request_token_missing",
      reason: "no-header",
    },
    {
      case: "no headers at all",
      headers: {},
      response: UNAUTHORIZED,
      event: "viewer_request_token_missing",
      reason: "no-header",
    },
    {
      case: "a malformed token",
      headers: pipelineHeaders({
        "x-flex-ci-token": `${token()}.c2VjcmV0LXNlZ21lbnQ`,
      }),
      response: UNAUTHORIZED,
      event: "viewer_request_token_invalid",
      reason: "segments",
    },
    {
      case: "an expired token",
      headers: pipelineHeaders({ "x-flex-ci-token": token({}, { exp: NOW }) }),
      response: UNAUTHORIZED,
      event: "viewer_request_token_expired",
      reason: "expired",
    },
    {
      case: "a token for another audience",
      headers: pipelineHeaders({
        "x-flex-ci-token": token({}, { aud: "https://github.com/example-org" }),
      }),
      response: UNAUTHORIZED,
      event: "viewer_request_token_invalid",
      reason: "audience",
    },
    {
      case: "a repeated token header",
      headers: pipelineHeaders({ "x-flex-ci-token": [token(), "forged"] }),
      response: UNAUTHORIZED,
      event: "viewer_request_token_invalid",
      reason: "repeated",
    },
    // OAC replaces Authorization with CloudFront's own signature, so a token there is no token.
    {
      case: "a token in Authorization instead",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
        "x-amz-content-sha256": CONTENT_HASH,
      },
      response: UNAUTHORIZED,
      event: "viewer_request_token_missing",
      reason: "no-header",
    },
    {
      case: "no token and no valid path",
      uri: "/nowhere",
      headers: {},
      response: UNAUTHORIZED,
      event: "viewer_request_token_missing",
      reason: "no-header",
    },
    {
      case: "a method no route takes",
      method: "GET",
      headers: pipelineHeaders(),
      response: METHOD_NOT_ALLOWED,
      event: "viewer_request_method_rejected",
    },
    {
      case: "a method no route takes, with no token",
      method: "OPTIONS",
      headers: {},
      response: METHOD_NOT_ALLOWED,
      event: "viewer_request_method_rejected",
    },
    {
      case: "a path outside the pipeline API",
      uri: "/api/environments",
      headers: pipelineHeaders(),
      response: NOT_FOUND,
      event: "viewer_request_path_rejected",
    },
    {
      case: "the root",
      uri: "/",
      headers: pipelineHeaders(),
      response: NOT_FOUND,
      event: "viewer_request_path_rejected",
    },
    {
      case: "a path that isn't plain",
      uri: "/ci/environments/../../api",
      headers: pipelineHeaders(),
      response: NOT_FOUND,
      event: "viewer_request_path_rejected",
    },
    {
      case: "a body that isn't JSON",
      headers: pipelineHeaders({ "content-type": "text/plain" }),
      response: UNSUPPORTED,
      event: "viewer_request_content_type_rejected",
    },
    {
      case: "a body with no content type",
      headers: {
        "x-flex-ci-token": token(),
        "x-amz-content-sha256": CONTENT_HASH,
      },
      response: UNSUPPORTED,
      event: "viewer_request_content_type_rejected",
    },
    {
      case: "a repeated content type",
      headers: pipelineHeaders({
        "content-type": ["application/json", "text/plain"],
      }),
      response: UNSUPPORTED,
      event: "viewer_request_content_type_rejected",
    },
    {
      case: "a body without its hash",
      headers: {
        "x-flex-ci-token": token(),
        "content-type": "application/json",
      },
      response: BAD_REQUEST,
      event: "viewer_request_content_hash_rejected",
    },
    {
      case: "a hash that isn't a SHA-256",
      headers: pipelineHeaders({ "x-amz-content-sha256": "UNSIGNED-PAYLOAD" }),
      response: BAD_REQUEST,
      event: "viewer_request_content_hash_rejected",
    },
    {
      case: "a repeated hash",
      headers: pipelineHeaders({
        "x-amz-content-sha256": [CONTENT_HASH, CONTENT_HASH],
      }),
      response: BAD_REQUEST,
      event: "viewer_request_content_hash_rejected",
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

  // A request with several faults gets the answer that says least: the method's, then the
  // token's, and only a caller with a token learns anything of the paths.
  describe("the order of the checks", () => {
    it("answers a wrong method before a missing token", () => {
      expect(run({ method: "GET", uri: "/nowhere", headers: {} })).toEqual(
        METHOD_NOT_ALLOWED,
      );
    });

    it("answers a missing token before a wrong path", () => {
      expect(
        run({
          uri: "/nowhere",
          headers: pipelineHeaders({ "x-flex-ci-token": "" }),
        }),
      ).toEqual(UNAUTHORIZED);
    });

    it("answers a wrong path before a wrong content type", () => {
      expect(
        run({
          uri: "/nowhere",
          headers: pipelineHeaders({ "content-type": "text/plain" }),
        }),
      ).toEqual(NOT_FOUND);
    });

    it("answers a wrong content type before a missing hash", () => {
      expect(
        run({
          headers: { "x-flex-ci-token": token(), "content-type": "text/plain" },
        }),
      ).toEqual(UNSUPPORTED);
    });
  });

  describe("the methods", () => {
    // CloudFront passes on any method a viewer sends, in any case, and HTTP methods are
    // case-sensitive.
    it.each(["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "post"])(
      "refuses %s with a 405 naming the one it serves",
      (method) => {
        expect(run({ method })).toEqual(METHOD_NOT_ALLOWED);
      },
    );
  });

  describe("the content type", () => {
    it.each([
      "application/json",
      "application/json; charset=utf-8",
      "Application/JSON",
    ])("passes %s", (contentType) => {
      const result = run({
        headers: pipelineHeaders({ "content-type": contentType }),
      });

      expect(result).not.toHaveProperty("statusCode");
    });

    it.each(["application/jsonp", "application/json-patch+json", "text/json"])(
      "refuses %s",
      (contentType) => {
        expect(
          run({ headers: pipelineHeaders({ "content-type": contentType }) }),
        ).toEqual(UNSUPPORTED);
      },
    );
  });
});
