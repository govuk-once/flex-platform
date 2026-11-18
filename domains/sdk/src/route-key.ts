import type { HttpMethod, ParsedRouteKey, RouteKeyResult } from "./types.ts";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const METHODS: ReadonlySet<string> = new Set(HTTP_METHODS);

const VERSION = /^v([1-9][0-9]*)$/;

const LITERAL = /^[a-z][a-z0-9-]*$/;

const PARAMETER = /^\{([a-z][a-zA-Z0-9]*)\}$/;

function isHttpMethod(method: string): method is HttpMethod {
  return METHODS.has(method);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// "push-tokens" reads as "PushTokens", and "{linkId}" as "ByLinkId".
function segmentName(segment: string): string {
  const parameter = PARAMETER.exec(segment)?.[1];

  if (parameter !== undefined) return `By${capitalise(parameter)}`;

  return segment.split("-").map(capitalise).join("");
}

// The grammar is `<METHOD> /v<n>/<segment>(/<segment>)*`, where a segment is lowercase letters,
// digits and hyphens starting with a letter, or a parameter such as `{id}` in camel case. Every
// problem is reported, so a key that breaks several rules is fixed in one go.
export function parseRouteKey(key: string): RouteKeyResult {
  // A set, so a key with several empty segments reports that once.
  const problems = new Set<string>();

  const space = key.indexOf(" ");
  const method = space < 0 ? key : key.slice(0, space);
  const path = space < 0 ? "" : key.slice(space + 1);

  if (!isHttpMethod(method)) {
    problems.add(
      "a route key starts with GET, POST, PUT, PATCH or DELETE, then one space",
    );
  }

  const [, versionSegment = "", ...segments] = path.split("/");

  const version = VERSION.exec(versionSegment)?.[1];

  if (!path.startsWith("/") || version === undefined) {
    problems.add("the path starts with a version, such as /v1");
  } else if (segments.length === 0) {
    problems.add("the path has at least one segment after the version");
  }

  const parameters: string[] = [];

  for (const segment of segments) {
    const parameter = PARAMETER.exec(segment)?.[1];

    if (parameter !== undefined) {
      if (parameters.includes(parameter)) {
        problems.add(`the path parameter {${parameter}} appears twice`);
      }

      parameters.push(parameter);
    } else if (segment === "") {
      problems.add("the path has an empty segment or ends with a slash");
    } else if (!LITERAL.test(segment)) {
      problems.add(
        `the segment "${segment}" is not lowercase letters, digits and hyphens starting with a letter, or a parameter such as {id}`,
      );
    }
  }

  // The method and version are checked again only so the compiler knows their types here.
  if (problems.size > 0 || !isHttpMethod(method) || version === undefined) {
    return { ok: false, problems: [...problems] };
  }

  const route: ParsedRouteKey = {
    method,
    version: Number(version),
    path,
    parameters,
    name: `${method.toLowerCase()}V${version}${segments.map(segmentName).join("")}`,
    shape: `${method} ${path.replace(/\{[^}]*\}/g, "{}")}`,
  };

  return { ok: true, route };
}
