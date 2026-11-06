import type { EnvelopeInbound } from "@repo/gateway-core";
import { isRecord } from "@repo/utils/is-record";

import { GatewayError } from "./errors.ts";

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

  // The token may be missing, which the token step refuses as UNAUTHENTICATED: a domain that forgot
  // it. A `secure` of the wrong shape is a malformed envelope.
  if (event.secure !== undefined) {
    if (!isRecord(event.secure)) {
      throw new GatewayError(
        "INVALID_INPUT",
        "Envelope 'secure' must be an object",
      );
    }
    if (
      event.secure.token !== undefined &&
      typeof event.secure.token !== "string"
    ) {
      throw new GatewayError(
        "INVALID_INPUT",
        "Envelope 'secure.token' must be a string",
      );
    }
  }

  return event as unknown as EnvelopeInbound;
}
