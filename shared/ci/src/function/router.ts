// The API's routes, each a method, a path and the handler that answers it. Every route is a
// pipeline's, for an environment and a domain, which its path names, and takes the same
// authorisation: the API finds a request's route only once its token verifies, and runs the
// route's handler only once the pipeline is allowed for the path's environment and domain. So no
// handler checks either, and no route can leave them out. A caller of another kind belongs to
// another function, under another path.

import type { ReleaseTarget } from "./authorise.ts";
import type { CiOptions } from "./options.ts";
import type { OutcomeDetails, RequestDetails } from "./telemetry.ts";
import type { Pipeline } from "./token.ts";
import type { FunctionUrlEvent, FunctionUrlResult } from "./types.ts";

/** What a route's handler is given: the request, once its caller is allowed. */
export interface RouteContext {
  readonly event: FunctionUrlEvent;
  readonly traceId: string;
  readonly pipeline: Pipeline;
  /** The path's environment and domain, which are the config's once allowed. */
  readonly target: ReleaseTarget;
  /** The path's other parameters, by name. Still only the caller's. */
  readonly params: ReadonlyMap<string, string>;
  /** What the log says of the request so far: the caller, and the target. */
  readonly details: OutcomeDetails;
  readonly request: () => RequestDetails;
}

export type RouteHandler = (
  options: CiOptions,
  context: RouteContext,
) => Promise<FunctionUrlResult>;

export interface RouteDefinition {
  readonly method: string;
  /** The path, with each parameter one whole segment in braces, such as `{domain}`. */
  readonly path: string;
  readonly handle: RouteHandler;
}

/** A request's route, and its path's parameters. */
export interface MatchedRoute {
  readonly route: RouteDefinition;
  readonly params: ReadonlyMap<string, string>;
}

/** What a request's method and path find. */
export type RouteMatch =
  | { readonly kind: "route"; readonly match: MatchedRoute }
  /** The path is a route's, but not for this method: these are the methods it takes. */
  | { readonly kind: "method"; readonly allowed: readonly string[] }
  | { readonly kind: "none" };

type Segment = { readonly literal: string } | { readonly param: string };

interface CompiledRoute {
  readonly route: RouteDefinition;
  readonly segments: readonly Segment[];
}

const PARAM = /^\{([a-z][A-Za-z]*)\}$/;

// What the authorisation reads from every route's path.
const TARGET_PARAMS = ["environment", "domain"];

export type Router = (method: string, path: string) => RouteMatch;

/**
 * Compiles the routes once. Throws for a route the router couldn't tell apart from another, or
 * whose path doesn't name an environment and a domain, so a mistake fails when the function starts.
 */
export function createRouter(routes: readonly RouteDefinition[]): Router {
  const compiled = routes.map(compile);
  const seen = new Set<string>();
  for (const { route, segments } of compiled) {
    // Two routes whose paths differ only in their parameters' names would be the same.
    const shape = `${route.method} ${segments
      .map((segment) => ("literal" in segment ? segment.literal : "{}"))
      .join("/")}`;
    if (seen.has(shape)) {
      throw new Error(`Two routes are ${route.method} ${route.path}`);
    }
    seen.add(shape);
  }

  return (method, path) => {
    // Nothing is decoded: the CloudFront Function lets only a plain path through, and a name
    // that isn't in the config is refused by the authorisation.
    const parts = path.split("/");
    const allowed: string[] = [];
    for (const { route, segments } of compiled) {
      const params = paramsOf(segments, parts);
      if (params === undefined) continue;
      if (route.method === method) {
        return { kind: "route", match: { route, params } };
      }
      allowed.push(route.method);
    }
    return allowed.length === 0
      ? { kind: "none" }
      : { kind: "method", allowed };
  };
}

function compile(route: RouteDefinition): CompiledRoute {
  if (!route.path.startsWith("/")) {
    throw new Error(`The route ${route.path} doesn't start with "/"`);
  }
  const segments = route.path.split("/").map((part): Segment => {
    const param = PARAM.exec(part)?.[1];
    return param === undefined ? { literal: part } : { param };
  });
  const names = segments.flatMap((segment) =>
    "param" in segment ? [segment.param] : [],
  );
  if (new Set(names).size !== names.length) {
    throw new Error(`The route ${route.path} names a parameter twice`);
  }
  for (const name of TARGET_PARAMS) {
    if (!names.includes(name)) {
      throw new Error(`The route ${route.path} has no {${name}}`);
    }
  }
  return { route, segments };
}

// Each parameter is one whole segment, and never empty. Literals match exactly, case and all.
function paramsOf(
  segments: readonly Segment[],
  parts: readonly string[],
): Map<string, string> | undefined {
  if (parts.length !== segments.length) return undefined;
  const params = new Map<string, string>();
  for (const [index, segment] of segments.entries()) {
    const part = parts[index];
    if (part === undefined) return undefined;
    if ("literal" in segment) {
      if (part !== segment.literal) return undefined;
    } else {
      if (part === "") return undefined;
      params.set(segment.param, part);
    }
  }
  return params;
}
