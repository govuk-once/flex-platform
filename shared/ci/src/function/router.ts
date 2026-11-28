// The API's routes, each a method, a path and the handler that answers it. Every route is a
// pipeline's, for an environment and a domain, which its path names, and takes the same
// authorisation: the API finds a request's route only once its token verifies, and runs the
// route's handler only once the pipeline is allowed for the path's environment and domain. So no
// handler checks either, and no route can leave them out. A caller of another kind belongs to
// another function, under another path.

import {
  type RouteMatch as Match,
  routeMatcher,
} from "@repo/utils/route-matcher";

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
  | Exclude<Match<RouteDefinition>, { readonly kind: "route" }>;

// What the authorisation reads from every route's path.
const TARGET_PARAMS = ["environment", "domain"];

export type Router = (method: string, path: string) => RouteMatch;

/**
 * Finds a request's route with `routeMatcher`, which decodes a path's literal segments but never
 * its parameters, so a name that isn't in the config is still refused by the authorisation.
 * Throws for a route the matcher refuses, or whose path doesn't name an environment and a domain,
 * so a mistake fails when the function starts.
 */
export function createRouter(routes: readonly RouteDefinition[]): Router {
  for (const { path } of routes) {
    const segments = path.split("/");
    for (const name of TARGET_PARAMS) {
      if (!segments.includes(`{${name}}`)) {
        throw new Error(`The route ${path} has no {${name}}`);
      }
    }
  }
  const match = routeMatcher(routes);

  return (method, path) => {
    const found = match(method, path);
    if (found.kind !== "route") return found;
    return {
      kind: "route",
      match: { route: found.route, params: found.params },
    };
  };
}
