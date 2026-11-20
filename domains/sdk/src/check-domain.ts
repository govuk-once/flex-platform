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

import { HANDLER_REJECTION_CODES, ROUTE_REJECTION_CODES } from "./errors.ts";
import { NULL_BODY_STATUS_CODES, SUCCESS_STATUS_CODES } from "./http.ts";
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
  "errors",
]);

const SUCCESS_STATUSES: ReadonlySet<string> = new Set(
  SUCCESS_STATUS_CODES.map(String),
);

const NULL_BODY_STATUSES: ReadonlySet<string> = new Set(
  NULL_BODY_STATUS_CODES.map(String),
);

const ROUTE_CODES: ReadonlySet<string> = new Set(ROUTE_REJECTION_CODES);

const HANDLER_CODES: ReadonlySet<string> = new Set(HANDLER_REJECTION_CODES);

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

function responsesProblems(at: string, responses: unknown): string[] {
  if (!isRecord(responses)) {
    return [`${at}: must be an object of schemas keyed by status`];
  }

  const statuses = Object.entries(responses);

  if (statuses.length === 0) return [`${at}: must declare at least one status`];

  return statuses.flatMap(([status, schema]) => [
    ...(SUCCESS_STATUSES.has(status)
      ? []
      : [
          `${at}[${status}]: is not a success status; accepted statuses: 2xx, with a failure as a code in errors`,
        ]),
    ...(schema === null || schema instanceof ZodType
      ? []
      : [`${at}[${status}]: must be a Zod schema, or null for no body`]),
    ...(NULL_BODY_STATUSES.has(status) && schema instanceof ZodType
      ? [`${at}[${status}]: must be null, as a ${status} response has no body`]
      : []),
  ]);
}

function errorsProblems(at: string, errors: unknown): string[] {
  if (errors === undefined) return [];

  if (!Array.isArray(errors)) return [`${at}: must be a list of codes`];

  return errors.flatMap((code: unknown, index) => {
    const codeAt = `${at}[${index}]`;

    const first = errors.indexOf(code);

    if (first >= 0 && first < index) {
      return [
        `${codeAt}: ${JSON.stringify(code)} is already listed at errors[${first}]`,
      ];
    }

    if (typeof code === "string" && ROUTE_CODES.has(code)) return [];

    if (typeof code === "string" && HANDLER_CODES.has(code)) {
      return [
        `${codeAt}: "${code}" must not be listed, as any handler may reject with it`,
      ];
    }

    return [
      `${codeAt}: ${JSON.stringify(code)} is not a route code; accepted codes: ${ROUTE_REJECTION_CODES.join(", ")}`,
    ];
  });
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
      problems.push(
        `${at}.body: must be left out, as a ${parsed.method} route takes no body`,
      );
    } else {
      problems.push(...strictInputProblems(body, `${at}.body`));
    }
  }

  problems.push(
    ...responsesProblems(`${at}.responses`, responses),
    ...errorsProblems(`${at}.errors`, errors),
  );

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
