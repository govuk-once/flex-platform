// What a domain's configuration is held to as it loads: defineDomain runs it, so it runs wherever
// the configuration is imported, in a domain's tests, its CI and as its function starts. It
// repeats what the types hold, for a configuration that bypassed them, and adds what the types
// cannot see: the domain's name, the key grammar in full, two keys that are one route or derive
// one name, and an input object that takes fields it does not name. Every problem is collected
// before anything is thrown, so one run reports them all, each as the field it is about and the
// rule it broke.
//
// A handler is checked only to be a function. The route it was typed for exists only in the
// types, which hold it there.

import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";
import { isRecord } from "@repo/utils/is-record";
import { ZodObject, ZodType } from "zod";

import { ROUTE_REJECTION_CODES } from "./errors.ts";
import { parseRouteKey } from "./route-key.ts";
import { strictInputProblems } from "./strict-input.ts";
import type { ParsedRouteKey } from "./types.ts";

export const SUCCESS_STATUS_CODES = [
  200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
] as const;

export const NULL_BODY_STATUS_CODES = [204, 205] as const;

const DOMAIN_CONFIG_FIELDS: ReadonlySet<string> = new Set(["name", "routes"]);

const ROUTE_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  "handler",
  "params",
  "query",
  "body",
  "responses",
  "errors",
]);

const SUCCESS_STATUSES: ReadonlySet<string> = new Set(
  SUCCESS_STATUS_CODES.map(String),
);

const NULL_BODY_STATUSES: ReadonlySet<string> = new Set(
  NULL_BODY_STATUS_CODES.map(String),
);

const ROUTE_CODES: ReadonlySet<string> = new Set(ROUTE_REJECTION_CODES);

function routeAt(key: string): string {
  return `routes[${JSON.stringify(key)}]`;
}

function unknownFields(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  at: (field: string) => string,
  rule: string,
): string[] {
  return Object.keys(record)
    .filter((field) => !known.has(field))
    .map((field) => `${at(field)}: ${rule}`);
}

function paramsProblems(
  at: string,
  params: unknown,
  parsed: ParsedRouteKey | undefined,
): string[] {
  const parameters = parsed?.parameters ?? [];

  if (params === undefined) {
    return parameters.length > 0
      ? [
          `${at}: the route key has path parameters, so params is required, with the keys ${parameters.join(", ")}`,
        ]
      : [];
  }

  if (!(params instanceof ZodObject)) return [`${at}: must be a Zod object`];

  if (parsed === undefined) return [];

  if (parameters.length === 0) {
    return [
      `${at}: the route key has no path parameter, so it takes no params`,
    ];
  }

  const keys = Object.keys(params.shape);

  return [
    ...parameters
      .filter((parameter) => !keys.includes(parameter))
      .map(
        (parameter) =>
          `${at}: path parameter '${parameter}' is missing from params`,
      ),
    ...keys
      .filter((key) => !parameters.includes(key))
      .map((key) => `${at}: params key '${key}' is not a path parameter`),
  ];
}

function responsesProblems(at: string, responses: unknown): string[] {
  if (!isRecord(responses)) {
    return [`${at}: must be an object of schemas keyed by status`];
  }

  const statuses = Object.entries(responses);

  if (statuses.length === 0) return [`${at}: needs at least one status`];

  return statuses.flatMap(([status, schema]) => [
    ...(SUCCESS_STATUSES.has(status)
      ? []
      : [
          `${at}[${status}]: status ${status} is not 2xx: a failure is a code in errors`,
        ]),
    ...(schema === null || schema instanceof ZodType
      ? []
      : [`${at}[${status}]: must be a Zod schema, or null for no body`]),
    ...(NULL_BODY_STATUSES.has(status) && schema instanceof ZodType
      ? [
          `${at}[${status}]: status ${status} has no body, so its schema is null`,
        ]
      : []),
  ]);
}

function errorsProblems(at: string, errors: unknown): string[] {
  if (errors === undefined) return [];

  if (!Array.isArray(errors)) return [`${at}: must be a list of codes`];

  return errors.flatMap((code: unknown, index) => [
    ...(typeof code === "string" && ROUTE_CODES.has(code)
      ? []
      : [
          `${at}[${index}]: ${JSON.stringify(code)} is not one of ${ROUTE_REJECTION_CODES.join(", ")}`,
        ]),
    ...(errors.indexOf(code) < index
      ? [`${at}[${index}]: ${JSON.stringify(code)} is listed twice`]
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
    "not a route field",
  );

  const { handler, params, query, body, responses, errors } = route;

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
      problems.push(`${at}.body: a ${parsed.method} route takes no body`);
    } else {
      problems.push(...strictInputProblems(body, `${at}.body`));
    }
  }

  problems.push(...responsesProblems(`${at}.responses`, responses));
  problems.push(...errorsProblems(`${at}.errors`, errors));

  return problems;
}

// Each value more than one key shares, with those keys in the order the configuration declares
// them.
function sharedKeys(
  parsed: ReadonlyMap<string, ParsedRouteKey>,
  by: (route: ParsedRouteKey) => string,
): [string, string[]][] {
  const groups = new Map<string, string[]>();

  for (const [key, route] of parsed) {
    groups.set(by(route), [...(groups.get(by(route)) ?? []), key]);
  }

  return [...groups].filter(([, keys]) => keys.length > 1);
}

function keyCollisionProblems(
  parsed: ReadonlyMap<string, ParsedRouteKey>,
): string[] {
  return [
    ...sharedKeys(parsed, (route) => route.shape).map(
      ([, keys]) =>
        `${keys.map(routeAt).join(" and ")}: the same method and path, since a path parameter matches any value`,
    ),
    ...sharedKeys(parsed, (route) => route.name).map(
      ([name, keys]) =>
        `${keys.map(routeAt).join(" and ")}: each derives the name "${name}"`,
    ),
  ];
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
    "not a domain field",
  );

  const { name, routes } = config;

  if (typeof name !== "string" || !isPlatformName(name)) {
    problems.push(
      "name: 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen",
    );
  }

  if (!isRecord(routes)) {
    problems.push("routes: must be an object of routes keyed by route key");

    return problems;
  }

  const entries = Object.entries(routes);

  if (entries.length === 0) problems.push("routes: needs at least one route");

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
