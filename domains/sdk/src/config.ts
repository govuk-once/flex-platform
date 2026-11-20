// The configuration a domain declares, and the domain() factory that binds route() to it.
//
// This is the least that typing route() needs, and no more: each route's schemas, keyed by
// version, path and method, with the headers every route shares and the logging settings. The
// domain configuration ticket replaces it with the full factory, which adds route names, the
// checks a configuration is held to as it loads, path parameters inferred from the key, the
// OpenAPI document and the serialised form. Nothing here should grow towards those.

import type { ZodType } from "zod";

import type { RouteFailureCode } from "./errors.ts";
import type { HttpMethod } from "./http.ts";
import { setFallbackLogger } from "./logging/log.ts";
import type { LoggingOptions } from "./logging/logger.ts";
import { createLogger } from "./logging/logger.ts";
import { createRouteContextReader, createRouteFactory } from "./route.ts";
import type { RouteContextReader, RouteFactory } from "./types.ts";

export interface HeaderDeclaration {
  /** The header's name on the wire, matched without regard to case. */
  readonly name: string;
  /** Required unless false. A required header that is missing is a 400. */
  readonly required?: boolean;
}

/** Headers by the alias a handler reads them as. */
export type HeaderDeclarations = Readonly<Record<string, HeaderDeclaration>>;

/** A schema for the body of each status a route answers with, or null for a status with none. */
export type ResponseDeclarations = Readonly<Record<number, ZodType | null>>;

export interface RouteDeclaration {
  /** The path's parameters. Without it, a handler sees none. */
  readonly params?: ZodType;
  readonly query?: ZodType;
  readonly headers?: HeaderDeclarations;
  /** A request body, parsed from JSON. The route then requires `Content-Type: application/json`. */
  readonly body?: ZodType;
  readonly responses: ResponseDeclarations;
  /** The failures the handler may answer with by name. */
  readonly errors?: readonly RouteFailureCode[];
}

export type MethodDeclarations = {
  readonly [Method in HttpMethod]?: RouteDeclaration;
};

/** Routes by path, such as `/todos/:id`, under their version, such as `v1`. */
export type RouteDeclarations = Readonly<
  Record<string, Readonly<Record<string, MethodDeclarations>>>
>;

export interface DomainConfig {
  readonly name: string;
  readonly common?: {
    /** Headers every route declares. A route's own header of the same alias replaces one. */
    readonly headers?: HeaderDeclarations;
    readonly logging?: LoggingOptions;
  };
  readonly routes: RouteDeclarations;
}

export interface Domain<Config extends DomainConfig> {
  readonly config: Config;
  readonly route: RouteFactory<Config>;
  readonly routeContext: RouteContextReader<Config>;
}

export function domain<const Config extends DomainConfig>(
  config: Config,
): Domain<Config> {
  const logger = createLogger(config.name, config.common?.logging);
  setFallbackLogger(logger);
  return {
    config,
    route: createRouteFactory(config, logger),
    routeContext: createRouteContextReader<Config>(),
  };
}
