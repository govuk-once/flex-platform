import type { ErrorCode } from "./errors.ts";
import { GatewayError } from "./errors.ts";

export interface EnvelopeRequest {
  readonly operation: string;
  readonly input: unknown;
  readonly secure: {
    readonly values: Record<string, unknown>;
    readonly signature: string;
  };
}

export interface EnvelopeSuccess {
  readonly ok: true;
  readonly outcome: string;
  readonly data: unknown;
}

export interface EnvelopeError {
  readonly ok: false;
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
  };
}

export type EnvelopeResponse = EnvelopeSuccess | EnvelopeError;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRequest(event: unknown): EnvelopeRequest {
  if (!isObject(event)) {
    throw new GatewayError("INVALID_INPUT", "Request must be a JSON object");
  }

  if (typeof event.operation !== "string" || event.operation.length === 0) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Request must have a non-empty string 'operation'",
    );
  }

  if (!isObject(event.input)) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Request 'input' must be an object",
    );
  }

  if (!isObject(event.secure)) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Request must have a 'secure' object",
    );
  }

  if (!isObject(event.secure.values)) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Request 'secure.values' must be an object",
    );
  }

  if (typeof event.secure.signature !== "string") {
    throw new GatewayError(
      "INVALID_INPUT",
      "Request 'secure.signature' must be a string",
    );
  }

  return event as unknown as EnvelopeRequest;
}
