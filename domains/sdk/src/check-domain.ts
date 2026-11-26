// What a domain's configuration is held to as it loads: defineDomain runs it, so it runs wherever
// the configuration is imported, in a domain's tests, its CI and as its function starts. It
// repeats what the types hold, for a configuration that bypassed them, and adds what the types
// cannot see: the domain's name, the key grammar in full, two keys that are one route, an input
// object that takes fields it does not name, a parameter that cannot be read from text. Every
// problem is collected before anything is thrown, so one run reports them all.
//
// A handler is checked only to be a function. The route it was typed for exists only in the
// types, which hold it there.

import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";
import { isRecord } from "@repo/utils/is-record";
import { ZodObject, ZodType } from "zod";

import { NULL_BODY_STATUS_CODES, RESPONSE_STATUS_CODES } from "./http.ts";
import type { ParameterLocation } from "./input-rules.ts";
import { parameterTypes, strictInputProblems } from "./input-rules.ts";
import { parseRouteKey } from "./route-key.ts";
import type { ParsedRouteKey } from "./types.ts";

const DOMAIN_CONFIG_FIELDS: ReadonlySet<string> = new Set(["name", "routes"]);

const ROUTE_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  "handler",
  "params",
  "query",
  "body",
  "responses",
]);

const RESPONSE_STATUSES: ReadonlySet<string> = new Set(
  RESPONSE_STATUS_CODES.map(String),
);

// The statuses the app reads as an expired token, whatever sent them.
const TOKEN_STATUSES: ReadonlySet<string> = new Set(["401", "403"]);

const SERVER_ERROR_STATUS = /^5\d\d$/;

const ACCEPTED_STATUS_CODES = RESPONSE_STATUS_CODES.join(", ");

const NULL_BODY_STATUSES: ReadonlySet<string> = new Set(
  NULL_BODY_STATUS_CODES.map(String),
);

const NAME_RULE =
  "1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen";

function routeAt(key: string): string {
  return `routes[${JSON.stringify(key)}]`;
}

function unknownFields(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  at: (field: string) => string,
): string[] {
  return Object.keys(record)
    .filter((field) => !known.has(field))
    .map(
      (field) =>
        `${at(field)}: unknown field, must be one of: ${[...known].join(", ")}`,
    );
}

function paramsProblems(
  at: string,
  params: unknown,
  parsed: ParsedRouteKey | undefined,
): string[] {
  const parameters = parsed?.parameters ?? [];

  if (params === undefined) {
    if (parameters.length === 0) return [];

    const placeholders = parameters.map((parameter) => `{${parameter}}`);

    return [
      `${at}: missing, required by path parameters: ${placeholders.join(", ")}`,
    ];
  }

  if (!(params instanceof ZodObject)) {
    return [`${at}: invalid type, must be an object schema`];
  }

  if (parsed === undefined) return [];

  if (parameters.length === 0) {
    return [`${at}: not allowed, the route key has no path parameters`];
  }

  const keys = Object.keys(params.shape);

  return [
    ...parameterProblems(params, "path", at),
    ...parameters
      .filter((parameter) => !keys.includes(parameter))
      .map(
        (parameter) =>
          `${at}.${parameter}: missing, required by path parameter {${parameter}}`,
      ),
    ...keys
      .filter((key) => !parameters.includes(key))
      .map(
        (key) =>
          `${at}.${key}: unknown path parameter, must be one of: ${parameters.join(", ")}`,
      ),
  ];
}

function parameterProblems(
  schema: ZodObject,
  location: ParameterLocation,
  at: string,
): string[] {
  const result = parameterTypes(schema, location);

  return result.ok ? [] : result.problems.map((problem) => `${at}.${problem}`);
}

function statusProblems(at: string, status: string): string[] {
  if (RESPONSE_STATUSES.has(status)) return [];

  if (TOKEN_STATUSES.has(status)) {
    return [
      `${at}[${status}]: status not allowed, the app treats a ${status} as an expired token`,
    ];
  }

  if (SERVER_ERROR_STATUS.test(status)) {
    return [
      `${at}[${status}]: status not allowed, any handler may return 500, 502, 503 or 504 undeclared`,
    ];
  }

  return [
    `${at}[${status}]: status not allowed, must be one of: ${ACCEPTED_STATUS_CODES}`,
  ];
}

function responsesProblems(at: string, responses: unknown): string[] {
  if (!isRecord(responses)) {
    return [
      `${at}: invalid type, must be an object of schemas keyed by status`,
    ];
  }

  const statuses = Object.entries(responses);

  if (statuses.length === 0)
    return [`${at}: empty, declare at least one status`];

  return statuses.flatMap(([status, schema]) => [
    ...statusProblems(at, status),
    ...(schema === null || schema instanceof ZodType
      ? []
      : [
          `${at}[${status}]: invalid type, must be a schema, or null for no body`,
        ]),
    ...(NULL_BODY_STATUSES.has(status) && schema instanceof ZodType
      ? [`${at}[${status}]: must be null, a ${status} response has no body`]
      : []),
  ]);
}

function routeProblems(
  key: string,
  route: unknown,
  parsed: ParsedRouteKey | undefined,
): string[] {
  const at = routeAt(key);

  if (!isRecord(route)) return [`${at}: invalid type, must be an object`];

  const problems = unknownFields(
    route,
    ROUTE_CONFIG_FIELDS,
    (field) => `${at}.${field}`,
  );

  const { handler, params, query, body, responses } = route;

  if (typeof handler !== "function") {
    problems.push(`${at}.handler: invalid type, must be a function`);
  }

  problems.push(...paramsProblems(`${at}.params`, params, parsed));

  if (query !== undefined) {
    problems.push(
      ...(query instanceof ZodObject
        ? [
            ...strictInputProblems(query, `${at}.query`),
            ...parameterProblems(query, "query", `${at}.query`),
          ]
        : [`${at}.query: invalid type, must be an object schema`]),
    );
  }

  if (body !== undefined) {
    if (!(body instanceof ZodType)) {
      problems.push(`${at}.body: invalid type, must be a schema`);
    } else if (parsed?.method === "GET" || parsed?.method === "DELETE") {
      problems.push(
        `${at}.body: not allowed, a ${parsed.method} route takes no body`,
      );
    } else {
      problems.push(...strictInputProblems(body, `${at}.body`));
    }
  }

  problems.push(...responsesProblems(`${at}.responses`, responses));

  return problems;
}

// Keys that match the same requests, in the order the configuration declares them.
function keyCollisionProblems(
  parsed: ReadonlyMap<string, ParsedRouteKey>,
): string[] {
  const byPattern = new Map<string, string[]>();

  for (const [key, { pattern }] of parsed) {
    byPattern.set(pattern, [...(byPattern.get(pattern) ?? []), key]);
  }

  return [...byPattern.values()]
    .filter((keys) => keys.length > 1)
    .map(
      (keys) =>
        `routes: duplicate routes, parameter names do not tell apart: ${keyList(keys)}`,
    );
}

function keyList(keys: readonly string[]): string {
  return keys.map((key) => JSON.stringify(key)).join(", ");
}

export class DomainConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        "The domain's configuration is not valid:",
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
    this.name = "DomainConfigError";
    this.problems = problems;
  }
}

function domainProblems(config: unknown): readonly string[] {
  if (!isRecord(config))
    return ["configuration: invalid type, must be an object"];

  const problems = unknownFields(
    config,
    DOMAIN_CONFIG_FIELDS,
    (field) => field,
  );

  const { name, routes } = config;

  if (typeof name !== "string") {
    problems.push("name: invalid type, must be a string");
  } else if (!isPlatformName(name)) {
    problems.push(`name: invalid format, must be ${NAME_RULE}`);
  }

  if (!isRecord(routes)) {
    problems.push(
      'routes: invalid type, must be an object of routes keyed "<METHOD> /<version>/<path>"',
    );

    return problems;
  }

  const entries = Object.entries(routes);

  if (entries.length === 0) {
    problems.push("routes: empty, declare at least one route");
  }

  const parsed = new Map<string, ParsedRouteKey>();

  for (const [key, route] of entries) {
    const result = parseRouteKey(key);

    if (result.ok) {
      parsed.set(key, result.route);
    } else {
      problems.push(
        ...result.problems.map((problem) => `${routeAt(key)}: ${problem}`),
      );
    }

    problems.push(
      ...routeProblems(key, route, result.ok ? result.route : undefined),
    );
  }

  return [...problems, ...keyCollisionProblems(parsed)];
}

/**
 * Throws a DomainConfigError listing every problem with a domain's configuration, each as the
 * field and the rule it broke.
 */
export function checkDomain(config: unknown): void {
  const problems = domainProblems(config);

  if (problems.length > 0) throw new DomainConfigError(problems);
}
