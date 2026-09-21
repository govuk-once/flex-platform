import { GatewayError } from "@repo/gateway-runtime";

// Characters that delimit URL structure. An upstream that percent-decodes before it normalises
// or routes would reinterpret them, so a path parameter can never contain one: "../../admin"
// encodes safely for this gateway's URL parser but still reaches /admin behind such a proxy.
// "%" is included so a double-decoding upstream cannot recover them either.
const PATH_DELIMITERS = /[/\\?#%]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

// None of these belongs in a path, and three of them change one. A path may not carry any.
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

// Every spelling the URL parser resolves as a dot segment. It resolves them before a request
// leaves, and without an error, so one in a path silently moves that request up and out of the
// target's own path.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

// Tab, newline and carriage return, which the URL parser removes from its input before it reads
// anything, percent escapes included: ".<tab>." reaches it as "..", and so does "%2<tab>e".
const STRIPPED_BY_PARSER = /[\t\n\r]/g;

// Whether a path carries such a segment, judged on the path the parser will see rather than the
// one written. The split takes a backslash as well, which the parser reads as a separator in an
// http path: "\..\" is a dot segment to it, and a check splitting on "/" alone would hand it
// straight to the upstream. A mapped path cannot reach here with one, since `parseUpstream`
// refuses a template that has one and `encodePathParam` refuses a value that could form one;
// this covers the paths neither sees, a handler's own above all.
export function hasDotSegment(path: string): boolean {
  return path
    .replace(STRIPPED_BY_PARSER, "")
    .split(/[/\\]/)
    .some((segment) => DOT_SEGMENT.test(segment));
}

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
  if (PATH_DELIMITERS.test(value) || hasControlCharacter(value)) {
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
