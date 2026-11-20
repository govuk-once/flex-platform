import type { HttpMethod } from "./http.ts";
import { HTTP_METHODS } from "./http.ts";
import type { RouteKeyResult } from "./types.ts";

const METHODS: ReadonlySet<string> = new Set(HTTP_METHODS);

const VERSION = /^v[1-9]\d*$/;

const LITERAL = /^[a-z][a-z0-9-]*$/;

const PARAMETER = /^\{([a-z][a-zA-Z0-9]*)\}$/;

function isHttpMethod(method: string): method is HttpMethod {
  return METHODS.has(method);
}

export function parseRouteKey(key: string): RouteKeyResult {
  const space = key.indexOf(" ");

  if (space < 0) {
    return {
      ok: false,
      problems: ['must have the format "<METHOD> /<version>/<path>"'],
    };
  }

  const problems = new Set<string>();

  const method = key.slice(0, space);
  const path = key.slice(space + 1);

  if (!isHttpMethod(method)) {
    problems.add(
      `${JSON.stringify(method)} is not a valid method, must be one of: ${HTTP_METHODS.join(", ")}`,
    );
  }

  const [, version = "", ...segments] = path.split("/");

  if (!path.startsWith("/") || !VERSION.test(version)) {
    problems.add("the path must start with a version, such as /v1");
  } else if (segments.length === 0) {
    problems.add("the path must have at least one segment after the version");
  }

  const parameters: string[] = [];
  // The path with each parameter's name left out, built from the segments already read, so no
  // pattern has to scan the path again.
  const pathSegments: string[] = [];

  for (const segment of segments) {
    const parameter = PARAMETER.exec(segment)?.[1];

    pathSegments.push(parameter === undefined ? segment : "{}");

    if (parameter !== undefined) {
      if (parameters.includes(parameter)) {
        problems.add(`the path parameter {${parameter}} must appear only once`);
      }

      parameters.push(parameter);
    } else if (segment === "") {
      problems.add(
        "the path must not have an empty segment or end with a slash",
      );
    } else if (!LITERAL.test(segment)) {
      problems.add(
        `the segment ${JSON.stringify(segment)} must be lowercase letters, digits and hyphens starting with a letter, or a parameter such as {id}`,
      );
    }
  }

  // The method is checked again only so the compiler knows its type here.
  if (problems.size > 0 || !isHttpMethod(method)) {
    return { ok: false, problems: [...problems] };
  }

  return {
    ok: true,
    route: {
      method,
      parameters,
      shape: `${method} /${version}/${pathSegments.join("/")}`,
    },
  };
}
