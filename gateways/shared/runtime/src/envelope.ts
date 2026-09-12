import type { EnvelopeInbound, SecureValue } from "@repo/gateway-types";

import { GatewayError } from "./errors.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecureValue(value: unknown): value is SecureValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  // Non-finite numbers stringify to null, which would sign differently than intended.
  return typeof value === "number" && Number.isFinite(value);
}

export function parseEnvelope(event: unknown): EnvelopeInbound {
  if (!isObject(event)) {
    throw new GatewayError("INVALID_INPUT", "Envelope must be a JSON object");
  }

  if (typeof event.operation !== "string" || event.operation.length === 0) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Envelope must have a non-empty string 'operation'",
    );
  }

  if (!isObject(event.input)) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Envelope 'input' must be an object",
    );
  }

  if (!isObject(event.secure)) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Envelope must have a 'secure' object",
    );
  }

  if (!isObject(event.secure.values)) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Envelope 'secure.values' must be an object",
    );
  }

  for (const [key, value] of Object.entries(event.secure.values)) {
    if (!isSecureValue(value)) {
      throw new GatewayError(
        "INVALID_INPUT",
        `Envelope 'secure.values.${key}' must be a string, finite number, boolean or null`,
      );
    }
  }

  if (typeof event.secure.signature !== "string") {
    throw new GatewayError(
      "INVALID_INPUT",
      "Envelope 'secure.signature' must be a string",
    );
  }

  return event as unknown as EnvelopeInbound;
}
