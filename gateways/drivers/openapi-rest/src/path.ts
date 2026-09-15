import { GatewayError } from "@repo/gateway-runtime";

// Characters that delimit URL structure. An upstream that percent-decodes before it normalises
// or routes would reinterpret them, so a path parameter can never contain one: "../../admin"
// encodes safely for this gateway's URL parser but still reaches /admin behind such a proxy.
// "%" is included so a double-decoding upstream cannot recover them either.
const PATH_DELIMITERS = /[/\\?#%]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

// Percent-encodes one path parameter as a single segment. Values the URL parser or a decoding
// upstream could treat as more than one segment are rejected rather than escaped; constrain
// path parameter formats in the input schema so callers get INVALID_INPUT instead. Failures
// are GatewayErrors so the runtime keeps their messages, which never quote the value.
export function encodePathParam(value: string, context: string): string {
  if (value.length === 0) {
    throw new GatewayError(
      "INTERNAL",
      `${context}: path parameter value must not be empty`,
    );
  }
  if (/^\.+$/.test(value)) {
    throw new GatewayError(
      "INTERNAL",
      `${context}: path parameter value would form a dot segment`,
    );
  }
  if (PATH_DELIMITERS.test(value) || CONTROL_CHARACTERS.test(value)) {
    throw new GatewayError(
      "INTERNAL",
      `${context}: path parameter value contains a character that cannot appear in a single path segment`,
    );
  }
  // encodeURIComponent raises a URIError for a lone surrogate. That error is not ours, so the
  // runtime would log it as source locations only and the diagnosis would be lost; rejecting
  // here keeps every failure a GatewayError. Substituting a replacement character would send
  // the upstream something the caller did not ask for.
  if (!value.isWellFormed()) {
    throw new GatewayError(
      "INTERNAL",
      `${context}: path parameter value is not well-formed Unicode`,
    );
  }
  return encodeURIComponent(value);
}
