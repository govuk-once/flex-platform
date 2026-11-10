import { ERROR_CODES } from "@repo/gateway-core";
import { describe, expect, it } from "vitest";

import {
  errorBody,
  fail,
  Failure,
  fromGatewayError,
  fromInvocationFailure,
  statusOf,
} from "./errors.ts";

describe("failures", () => {
  it("each have a status and a fixed body", () => {
    expect(statusOf("not_found")).toBe(404);
    expect(errorBody("not_found")).toEqual({
      message: "Not found",
      type: "client_error",
      code: "not_found",
    });
    expect(errorBody("unauthorized")).toEqual({
      message: "Unauthorized",
      type: "auth_error",
      code: "unauthorized",
    });
    expect(errorBody("internal").type).toBe("server_error");
  });

  it("are made by fail", () => {
    const failure = fail("conflict");
    expect(failure).toBeInstanceOf(Failure);
    expect(failure.code).toBe("conflict");
    expect(failure.status).toBe(409);
  });
});

describe("fromGatewayError", () => {
  it("answers for every code a gateway has", () => {
    for (const code of Object.keys(
      ERROR_CODES,
    ) as (keyof typeof ERROR_CODES)[]) {
      expect(fromGatewayError(code)).toBeInstanceOf(Failure);
    }
  });

  it("passes on what the upstream said, and takes the blame for the rest", () => {
    expect(fromGatewayError("NOT_FOUND").status).toBe(404);
    expect(fromGatewayError("UPSTREAM_TIMEOUT").status).toBe(504);
    expect(fromGatewayError("UPSTREAM_UNAVAILABLE").status).toBe(503);
    expect(fromGatewayError("SECURE_VALUE_MISMATCH").status).toBe(403);
    expect(fromGatewayError("INVALID_INPUT").status).toBe(502);
    expect(fromGatewayError("INTERNAL").status).toBe(502);
  });
});

describe("fromInvocationFailure", () => {
  it("maps a call the gateway did not answer", () => {
    expect(fromInvocationFailure("timed_out").status).toBe(504);
    expect(fromInvocationFailure("function_error").status).toBe(502);
    expect(fromInvocationFailure("invalid_response").status).toBe(502);
    expect(fromInvocationFailure("invoke_failed").status).toBe(500);
    expect(fromInvocationFailure("aborted").status).toBe(500);
  });
});
