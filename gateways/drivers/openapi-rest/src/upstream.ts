import { hasDotSegment } from "./path.ts";
import { HTTP_METHODS, type HttpMethod, isHttpMethod } from "./types.ts";

export type PathPart =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

export interface ParsedUpstream {
  readonly method: HttpMethod;
  readonly template: string;
  readonly parts: readonly PathPart[];
  readonly params: readonly string[];
}

const PARAM = /\{([^{}]*)\}/g;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// The parts a path template is written in: the text of it, and the parameters standing in it.
// A parameter need not be a whole segment — "/v1/{id}.json" is a parameter and text — and this
// is the one reading of that, shared by what builds a request and what fits a path to a
// document's template, so the two cannot disagree about where a parameter is.
export function pathParts(template: string): PathPart[] {
  const parts: PathPart[] = [];
  let last = 0;
  for (const match of template.matchAll(PARAM)) {
    const literal = template.slice(last, match.index);
    if (literal.length > 0) parts.push({ kind: "literal", value: literal });
    parts.push({ kind: "param", name: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  const tail = template.slice(last);
  if (tail.length > 0) parts.push({ kind: "literal", value: tail });
  return parts;
}
// A "%" a parameter's value could complete. "/x/%2e%{id}" with id "2e" sends "/x/%2e%2e", a
// dot segment the reviewed template never showed, so each escape must be whole in its literal.
const INCOMPLETE_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
// Parses "<METHOD> /path/{param}" into a method and path parts. Any failure is a configuration
// error, so callers run this when creating the executor rather than per request.
export function parseUpstream(upstream: string): ParsedUpstream {
  const space = upstream.indexOf(" ");
  if (space < 0) {
    throw new TypeError(
      `Upstream "${upstream}" must be "<METHOD> /<path>", for example "GET /users/{id}"`,
    );
  }

  const method = upstream.slice(0, space);
  const template = upstream.slice(space + 1);

  if (!isHttpMethod(method)) {
    throw new TypeError(
      `Upstream "${upstream}" uses unsupported method "${method}"; expected one of ${HTTP_METHODS.join(", ")}`,
    );
  }
  if (!template.startsWith("/")) {
    throw new TypeError(`Upstream "${upstream}" path must start with "/"`);
  }
  if (/[?#\s]/.test(template)) {
    throw new TypeError(
      `Upstream "${upstream}" path must not contain a query string, fragment or whitespace`,
    );
  }
  // The URL parser reads a backslash in an http path as a segment separator, so one would both
  // resegment the path and carry a dot segment past a check that splits on "/".
  if (template.includes("\\")) {
    throw new TypeError(
      `Upstream "${upstream}" path must not contain a backslash, which the URL parser reads as a segment separator`,
    );
  }

  const parts = pathParts(template);
  const params: string[] = [];
  for (const part of parts) {
    if (part.kind !== "param") continue;
    const name = part.name;
    if (!PARAM_NAME.test(name)) {
      throw new TypeError(
        `Upstream "${upstream}" has an invalid path parameter name "{${name}}"`,
      );
    }
    if (params.includes(name)) {
      throw new TypeError(
        `Upstream "${upstream}" declares path parameter "{${name}}" more than once`,
      );
    }
    params.push(name);
  }

  for (const part of parts) {
    if (part.kind !== "literal") continue;
    if (/[{}]/.test(part.value)) {
      throw new TypeError(
        `Upstream "${upstream}" has unbalanced braces in its path`,
      );
    }
    if (INCOMPLETE_ESCAPE.test(part.value)) {
      throw new TypeError(
        `Upstream "${upstream}" has an incomplete percent escape in its path; a parameter must not complete one`,
      );
    }
  }

  // Each parameter stands in as one ordinary character: its value is never empty, never only
  // dots and never holds a "%", so a segment containing one cannot be a dot segment whatever
  // the caller sends. Only segments made of literal text can be, and those are fixed here.
  const literals = parts
    .map((part) => (part.kind === "literal" ? part.value : "x"))
    .join("");
  if (hasDotSegment(literals)) {
    throw new TypeError(
      `Upstream "${upstream}" has a dot segment in its path, which the URL parser would resolve`,
    );
  }

  return { method, template, parts, params };
}
