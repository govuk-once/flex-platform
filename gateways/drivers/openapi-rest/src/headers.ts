// Headers the driver controls or that would let a request smuggle its own framing. Neither the
// gateway configuration nor a handler may set them.
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "host",
  "transfer-encoding",
  "connection",
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Creation-time failures are TypeErrors thrown out of createExecutor; at request time the
// caller passes a factory for GatewayError so the runtime keeps the message, which names the
// header only.
export type HeaderFailure = (message: string) => Error;

const configurationFailure: HeaderFailure = (message) => new TypeError(message);

export function normaliseHeaderName(
  name: string,
  context: string,
  fail: HeaderFailure = configurationFailure,
): string {
  if (!HEADER_NAME.test(name)) {
    throw fail(`${context}: "${name}" is not a valid header name`);
  }
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower)) {
    throw fail(`${context}: header "${name}" is set by the driver`);
  }
  return lower;
}

// What Node's HTTP transport accepts when it sends: tab, then printable and high bytes. It is
// stricter than the Headers class, which passes other control characters through to a transport
// error quoting the value. Checking here means no library ever sees one to quote.
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

// Leading or trailing space or tab, which the Headers class strips before sending.
const EDGE_WHITESPACE = /^[ \t]|[ \t]$/;

export function isValidHeaderValue(value: string): boolean {
  return HEADER_VALUE.test(value);
}

// A value the transport sends exactly as given. A credential must pass this, or the upstream
// receives something other than what the secret holds.
export function isVerbatimHeaderValue(value: string): boolean {
  return isValidHeaderValue(value) && !EDGE_WHITESPACE.test(value);
}

// Diagnostics name the header, never its value, and never wrap a library error as a cause.
export function validateHeaders(
  headers: Readonly<Record<string, string>>,
  context: string,
  fail: HeaderFailure = configurationFailure,
): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const key = normaliseHeaderName(name, context, fail);
    if (typeof value !== "string" || !isValidHeaderValue(value)) {
      throw fail(`${context}: header "${name}" has an invalid value`);
    }
    try {
      out.set(key, value);
    } catch {
      throw fail(`${context}: header "${name}" has an invalid value`);
    }
  }
  return out;
}
