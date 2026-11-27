import { isCamelCase } from "@repo/utils/is-camel-case";

import type { HttpMethod } from "./http.ts";
import { HTTP_METHODS } from "./http.ts";
import type { RouteKeyResult } from "./types.ts";

const METHODS: ReadonlySet<string> = new Set(HTTP_METHODS);

const VERSION = /^v[1-9]\d*$/;

const LITERAL = /^[a-z][a-z0-9-]*$/;

const PARAMETER = /^\{(.*)\}$/;

function isHttpMethod(method: string): method is HttpMethod {
  return METHODS.has(method);
}

// The parameter a segment names, such as `id` for `{id}`.
function parameterOf(segment: string): string | undefined {
  const braced = PARAMETER.exec(segment)?.[1];

  return braced !== undefined && isCamelCase(braced) ? braced : undefined;
}

function literalProblem(segment: string): string | undefined {
  if (segment === "") {
    return "empty path segment, remove the extra or trailing slash";
  }

  return LITERAL.test(segment)
    ? undefined
    : `invalid segment ${JSON.stringify(segment)}, must be lowercase letters, digits and hyphens starting with a letter, or a parameter such as {id}`;
}

export function parseRouteKey(key: string): RouteKeyResult {
  const space = key.indexOf(" ");

  if (space < 0) {
    return {
      ok: false,
      problems: ['invalid route key, must be "<METHOD> /<version>/<path>"'],
    };
  }

  const problems = new Set<string>();

  const method = key.slice(0, space);
  const path = key.slice(space + 1);

  if (!isHttpMethod(method)) {
    problems.add(
      `invalid method ${JSON.stringify(method)}, must be one of: ${HTTP_METHODS.join(", ")}`,
    );
  }

  const [, version = "", ...segments] = path.split("/");

  if (!path.startsWith("/") || !VERSION.test(version)) {
    problems.add("missing version, start the path with one, such as /v1");
  } else if (segments.length === 0) {
    problems.add("missing path, add a segment after the version");
  }

  const parameters: string[] = [];
  // The path with each parameter's name left out, built from the segments already read, so no
  // pattern has to scan the path again.
  const pathSegments: string[] = [];

  for (const segment of segments) {
    const parameter = parameterOf(segment);

    if (parameter === undefined) {
      pathSegments.push(segment);

      const problem = literalProblem(segment);

      if (problem !== undefined) problems.add(problem);

      continue;
    }

    pathSegments.push("{}");

    if (parameters.includes(parameter)) {
      problems.add(`duplicate path parameter {${parameter}}, name each once`);
    }

    parameters.push(parameter);
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
      pattern: `${method} /${version}/${pathSegments.join("/")}`,
    },
  };
}
