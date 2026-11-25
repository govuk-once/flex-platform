// Finds the route a request's method and path ask for. It matches and dispatches nothing: what a
// route holds, and what is done with it, is the caller's.
//
// A path matches a route when it has as many segments, each literal segment is equal, case and
// all, and each parameter segment is not empty. Where several routes for the method match, the
// one with a literal segment wins at the first segment where their paths differ, so
// `/v1/todos/archived` beats `/v1/todos/{id}`. Nothing is decoded: a parameter is the segment as
// it was sent.

export interface Routable {
  readonly method: string;
  readonly path: string;
}

export type RouteMatch<Route extends Routable> =
  | {
      readonly kind: "route";
      readonly route: Route;
      readonly params: ReadonlyMap<string, string>;
    }
  /** The path is a route's, but not for this method: these are the methods it takes. */
  | { readonly kind: "method"; readonly allowed: readonly string[] }
  | { readonly kind: "none" };

type RouteSegment = { readonly literal: string } | { readonly param: string };

interface ParsedRoute<Route extends Routable> {
  readonly route: Route;
  readonly segments: readonly RouteSegment[];
}

interface SegmentsMatch<Route extends Routable> extends ParsedRoute<Route> {
  readonly params: Map<string, string>;
}

const PARAM_SEGMENT = /^\{([a-z][a-zA-Z0-9]*)\}$/;

function parseRoute<Route extends Routable>(route: Route): ParsedRoute<Route> {
  const { method, path } = route;

  if (!path.startsWith("/")) {
    throw new Error(`${method} ${path}: invalid path, must start with "/"`);
  }

  const segments = path.split("/").map((text): RouteSegment => {
    const param = PARAM_SEGMENT.exec(text)?.[1];

    return param === undefined ? { literal: text } : { param };
  });

  const paramNames = segments.flatMap((segment) =>
    "param" in segment ? [segment.param] : [],
  );

  const duplicates = new Set(
    paramNames.filter((name, index) => paramNames.indexOf(name) !== index),
  );

  if (duplicates.size > 0) {
    const names = [...duplicates].map((name) => `{${name}}`).join(", ");

    throw new Error(
      `${method} ${path}: duplicate parameter, name each once: ${names}`,
    );
  }

  return { route, segments };
}

// What two routes that match the same paths share: the method, and the path with each
// parameter's name left out.
function patternOf({ route, segments }: ParsedRoute<Routable>): string {
  const path = segments
    .map((segment) => ("literal" in segment ? segment.literal : "{}"))
    .join("/");

  return `${route.method} ${path}`;
}

// The route's parameters from the path's segments, or undefined when the path does not match.
function matchSegments(
  routeSegments: readonly RouteSegment[],
  pathSegments: readonly string[],
): Map<string, string> | undefined {
  if (pathSegments.length !== routeSegments.length) return undefined;

  const params = new Map<string, string>();

  for (const [index, routeSegment] of routeSegments.entries()) {
    const pathSegment = pathSegments[index];

    if (pathSegment === undefined) return undefined;

    if ("literal" in routeSegment) {
      if (pathSegment !== routeSegment.literal) return undefined;
    } else {
      if (pathSegment === "") return undefined;

      params.set(routeSegment.param, pathSegment);
    }
  }

  return params;
}

// Of two routes that match one path, and so have as many segments, whether `candidate` has the
// literal at the first segment where one has a literal and the other a parameter.
function orderByliteralFirst(
  candidate: readonly RouteSegment[],
  current: readonly RouteSegment[],
): boolean {
  for (const [index, segment] of candidate.entries()) {
    const isLiteral = "literal" in segment;

    const currentIsLiteral = "literal" in (current[index] ?? segment);

    if (isLiteral !== currentIsLiteral) return isLiteral;
  }

  return false;
}

/**
 * Parses the routes once, and answers with what a method and path find. Throws for a route that
 * names a parameter twice, and for two routes with the same method whose paths differ only in
 * their parameters' names, so a mistake fails when the routes are parsed.
 */
export function routeMatcher<Route extends Routable>(
  routes: readonly Route[],
): (method: string, path: string) => RouteMatch<Route> {
  const parsedRoutes = routes.map(parseRoute);

  const routesByPattern = new Map<string, Route>();

  for (const parsed of parsedRoutes) {
    const pattern = patternOf(parsed);

    const existing = routesByPattern.get(pattern);

    if (existing !== undefined) {
      const { method, path } = parsed.route;

      throw new Error(
        `${method} ${path}: duplicate route, matches the same paths as ${existing.method} ${existing.path}`,
      );
    }

    routesByPattern.set(pattern, parsed.route);
  }

  return (method, path) => {
    const pathSegments = path.split("/");

    const allowedMethods: string[] = [];

    let bestMatch: SegmentsMatch<Route> | undefined;

    for (const parsed of parsedRoutes) {
      const params = matchSegments(parsed.segments, pathSegments);

      if (params === undefined) continue;

      const { route, segments } = parsed;

      if (route.method !== method) {
        if (!allowedMethods.includes(route.method)) {
          allowedMethods.push(route.method);
        }
      } else if (
        bestMatch === undefined ||
        orderByliteralFirst(segments, bestMatch.segments)
      ) {
        bestMatch = { ...parsed, params };
      }
    }

    if (bestMatch !== undefined) {
      const { route, params } = bestMatch;

      return { kind: "route", route, params };
    }

    return allowedMethods.length === 0
      ? { kind: "none" }
      : { kind: "method", allowed: allowedMethods };
  };
}
