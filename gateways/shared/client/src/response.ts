import {
  type EnvelopeMeta,
  type EnvelopeResponse,
  ERROR_CODES,
  type ErrorCode,
  type MetaValue,
} from "@repo/gateway-core";
import { isRecord } from "@repo/utils/is-record";
import { isScalar } from "@repo/utils/is-scalar";
import { ownValue } from "@repo/utils/own-value";

// The function's answer read as a response envelope, or undefined if it is not one. The result
// is built from the fields an envelope has, so nothing else in the answer reaches the caller.
export function parseResponse(
  payload: Uint8Array,
): EnvelopeResponse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
    );
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const metaField = ownValue(value, "meta");
  const meta = isRecord(metaField) ? metaOf(metaField) : undefined;
  const withMeta = meta === undefined ? {} : { meta };

  const ok = ownValue(value, "ok");
  if (ok === true) {
    const outcome = ownValue(value, "outcome");
    if (typeof outcome !== "string" || !Object.hasOwn(value, "data")) {
      return undefined;
    }
    return { ok, outcome, data: value.data, ...withMeta };
  }
  if (ok === false) {
    const error = ownValue(value, "error");
    const code = isRecord(error) ? ownValue(error, "code") : undefined;
    if (!isErrorCode(code)) return undefined;
    return { ok: false, error: { code }, ...withMeta };
  }
  return undefined;
}

// Every part of `meta` is optional to a caller, so a value that is not a scalar is left out
// rather than failing the call, as the gateway does with one that fails its schema.
function metaOf(meta: Record<string, unknown>): EnvelopeMeta | undefined {
  const entries = Object.entries(meta).filter(
    (entry): entry is [string, MetaValue] => isScalar(entry[1]),
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

// Own keys only: a code named for something every object inherits is not one.
function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_CODES, code);
}
