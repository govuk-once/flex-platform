// What a domain's configuration is held to as it loads: defineDomain runs it, so it runs wherever
// the configuration is imported, in a domain's tests, its CI and as its function starts. It
// repeats what the types hold, for a configuration that bypassed them, and adds what the types
// cannot see: the domain's name, the key grammar in full, two keys that are one route, and an
// input object that takes fields it does not name. Every problem is collected before anything is
// thrown, so one run reports them all, each as `<field>: <what is wrong>; <what is accepted>`, the
// last part left out where it has no short answer.
//
// A handler is checked only to be a function. The route it was typed for exists only in the
// types, which hold it there.

import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";
import { isRecord } from "@repo/utils/is-record";
import { ZodObject, ZodType } from "zod";

import { NULL_BODY_STATUS_CODES, RESPONSE_STATUS_CODES } from "./http.ts";
import { parseRouteKey } from "./route-key.ts";
import { strictInputProblems } from "./strict-input.ts";
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
  kind: string,
): string[] {
  return Object.keys(record)
    .filter((field) => !known.has(field))
    .map(
      (field) =>
        `${at(field)}: is not a ${kind} field; accepted fields: ${[...known].join(", ")}`,
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
      `${at}: is required, with the route key's path parameters: ${placeholders.join(", ")}`,
    ];
  }

  if (!(params instanceof ZodObject)) return [`${at}: must be a Zod object`];

  if (parsed === undefined) return [];

  if (parameters.length === 0) {
    return [`${at}: must be left out, as the route key has no path parameter`];
  }

  const keys = Object.keys(params.shape);

  return [
    ...parameters
      .filter((parameter) => !keys.includes(parameter))
      .map(
        (parameter) =>
          `${at}: is missing the key for the path parameter {${parameter}}`,
      ),
    ...keys
      .filter((key) => !parameters.includes(key))
      .map(
        (key) =>
          `${at}.${key}: is not a path parameter; accepted keys: ${parameters.join(", ")}`,
      ),
  ];
}

function statusProblems(at: string, status: string): string[] {
  if (RESPONSE_STATUSES.has(status)) return [];

  if (TOKEN_STATUSES.has(status)) {
    return [
      `${at}[${status}]: must not be declared, as the app reads a ${status} as an expired token and sends the request again`,
    ];
  }

  if (SERVER_ERROR_STATUS.test(status)) {
    return [
      `${at}[${status}]: must not be declared, as any handler may answer with a 500, 502, 503 or 504, and with no other 5xx`,
    ];
  }

  return [
    `${at}[${status}]: is not a status a route may declare; accepted statuses: 2xx, and 4xx except 401 and 403`,
  ];
}

function responsesProblems(at: string, responses: unknown): string[] {
  if (!isRecord(responses)) {
    return [`${at}: must be an object of schemas keyed by status`];
  }

  const statuses = Object.entries(responses);

  if (statuses.length === 0) return [`${at}: must declare at least one status`];

  return statuses.flatMap(([status, schema]) => [
    ...statusProblems(at, status),
    ...(schema === null || schema instanceof ZodType
      ? []
      : [`${at}[${status}]: must be a Zod schema, or null for no body`]),
    ...(NULL_BODY_STATUSES.has(status) && schema instanceof ZodType
      ? [`${at}[${status}]: must be null, as a ${status} response has no body`]
      : []),
  ]);
}

function routeProblems(
  key: string,
  route: unknown,
  parsed: ParsedRouteKey | undefined,
): string[] {
  const at = routeAt(key);

  if (!isRecord(route)) return [`${at}: must be an object`];

  const problems = unknownFields(
    route,
    ROUTE_CONFIG_FIELDS,
    (field) => `${at}.${field}`,
    "route",
  );

  const { handler, params, query, body, responses } = route;

  if (typeof handler !== "function") {
    problems.push(`${at}.handler: must be a function`);
  }

  problems.push(...paramsProblems(`${at}.params`, params, parsed));

  if (query !== undefined) {
    problems.push(
      ...(query instanceof ZodObject
        ? strictInputProblems(query, `${at}.query`)
        : [`${at}.query: must be a Zod object`]),
    );
  }

  if (body !== undefined) {
    if (!(body instanceof ZodType)) {
      problems.push(`${at}.body: must be a Zod schema`);
    } else if (parsed?.method === "GET" || parsed?.method === "DELETE") {
      problems.push(
        `${at}.body: must be left out, as a ${parsed.method} route takes no body`,
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
  const byShape = new Map<string, string[]>();

  for (const [key, { shape }] of parsed) {
    byShape.set(shape, [...(byShape.get(shape) ?? []), key]);
  }

  return [...byShape.values()]
    .filter((keys) => keys.length > 1)
    .map(
      (keys) =>
        `routes: these keys match the same requests, because a path parameter's name does not distinguish routes: ${keys.map((key) => JSON.stringify(key)).join(", ")}`,
    );
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
  if (!isRecord(config)) return ["the configuration must be an object"];

  const problems = unknownFields(
    config,
    DOMAIN_CONFIG_FIELDS,
    (field) => field,
    "domain",
  );

  const { name, routes } = config;

  if (typeof name !== "string") {
    problems.push(`name: must be a string of ${NAME_RULE}`);
  } else if (!isPlatformName(name)) {
    problems.push(`name: ${JSON.stringify(name)} must be ${NAME_RULE}`);
  }

  if (!isRecord(routes)) {
    problems.push(
      'routes: must be an object of routes, each keyed "<METHOD> /<version>/<path>"',
    );

    return problems;
  }

  const entries = Object.entries(routes);

  if (entries.length === 0) {
    problems.push("routes: must declare at least one route");
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
