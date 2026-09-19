import type { EnvelopeInbound, SecureValue } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";
import { isScalar } from "@repo/utils/is-scalar";

import { GatewayError } from "./errors.ts";

function isSecureValue(value: unknown): value is SecureValue {
  // Null is a value a caller may assert; a number that JSON cannot write is not, since it would
  // reach the signature as null and sign differently than intended.
  return value === null || isScalar(value);
}

export function parseEnvelope(event: unknown): EnvelopeInbound {
  if (!isRecord(event)) {
    throw new GatewayError("INVALID_INPUT", "Envelope must be a JSON object");
  }

  if (typeof event.operation !== "string" || event.operation.length === 0) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Envelope must have a non-empty string 'operation'",
    );
  }

  if (!isRecord(event.input)) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Envelope 'input' must be an object",
    );
  }

  if (!isRecord(event.secure)) {
    throw new GatewayError(
      "INVALID_INPUT",
      "Envelope must have a 'secure' object",
    );
  }

  if (!isRecord(event.secure.values)) {
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
