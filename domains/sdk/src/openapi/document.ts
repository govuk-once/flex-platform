// A domain's routes and schemas as an OpenAPI 3.1 document, built from the configuration alone,
// with what the SDK answers on any route. The platform's parts, its server, access token and the
// Frontdoor's and API Gateway's answers, are added when the document is published, not here.

import type { ZodType } from "zod";

import { checkDomain, DomainConfigError } from "../check-domain.ts";
import type { DomainConfig } from "../types.ts";
import {
  jsonContent,
  PLATFORM_ERROR,
  PLATFORM_ERROR_SCHEMA,
  responsesOf,
} from "./responses.ts";
import type { ComponentsResult, DescribedSchema } from "./schemas.ts";
import {
  COMPONENTS_REF,
  describeSchema,
  isJsonSchema,
  nameComponents,
} from "./schemas.ts";
import type {
  OpenApiDocument,
  OpenApiOperation,
  OpenApiOptions,
  OpenApiParameter,
  SchemaUse,
} from "./types.ts";

const OPENAPI_VERSION = "3.1.0";

const RESERVED_NAMES: ReadonlyMap<string, string> = new Map([
  [PLATFORM_ERROR, "the platform's failure body"],
]);

interface DescribedRoute {
  readonly method: string;
  readonly path: string;
  readonly operationId: string | undefined;
  readonly description: string | undefined;
  readonly params: DescribedSchema | undefined;
  readonly query: DescribedSchema | undefined;
  readonly body: DescribedSchema | undefined;
  readonly responses: ReadonlyMap<number, DescribedSchema | null>;
}

type Components = Extract<ComponentsResult, { readonly ok: true }>;

// `required` is Zod's reading of an optional or defaulted field. A path parameter always is. A
// named object is a reference to its component, which holds the fields.
function parametersOf(
  described: DescribedSchema | undefined,
  location: "path" | "query",
  { resolve, schemas }: Components,
): OpenApiParameter[] {
  if (described === undefined) return [];

  const root = resolve(described);

  const { $ref } = root;

  const named =
    $ref?.startsWith(COMPONENTS_REF) === true
      ? schemas[$ref.slice(COMPONENTS_REF.length)]
      : undefined;

  const { properties = {}, required = [] } = named ?? root;

  return Object.entries(properties).flatMap(([name, schema]) =>
    isJsonSchema(schema)
      ? [
          {
            name,
            in: location,
            required: location === "path" || required.includes(name),
            schema,
          },
        ]
      : [],
  );
}

/**
 * Throws a DomainConfigError for a configuration checkDomain refuses, or listing every schema the
 * document cannot describe.
 */
export function buildOpenApiDocument(
  domain: DomainConfig,
  { version, title = domain.name }: OpenApiOptions,
): OpenApiDocument {
  checkDomain(domain);

  const problems: string[] = [];

  const described: DescribedSchema[] = [];

  // Nothing is built from a schema that has a problem: the build throws first.
  function describe(
    schema: ZodType | null | undefined,
    use: SchemaUse,
    at: string,
  ): DescribedSchema | undefined {
    if (schema === null || schema === undefined) return undefined;

    const result = describeSchema(schema, { use, at });

    if (!result.ok) {
      problems.push(result.problem);

      return undefined;
    }

    described.push(result.described);

    return result.described;
  }

  const routes = Object.entries(domain.routes).map(
    ([key, route]): DescribedRoute => {
      const space = key.indexOf(" ");

      const at = `routes[${JSON.stringify(key)}]`;

      const { operationId, description, params, query, body, responses } =
        route;

      return {
        method: key.slice(0, space).toLowerCase(),
        path: key.slice(space + 1),
        operationId,
        description,
        params: describe(params, "input", `${at}.params`),
        query: describe(query, "input", `${at}.query`),
        body: describe(body, "input", `${at}.body`),
        responses: new Map(
          Object.entries(responses).map(([status, schema]) => [
            Number(status),
            describe(schema, "output", `${at}.responses[${status}]`) ?? null,
          ]),
        ),
      };
    },
  );

  const components = nameComponents(described, RESERVED_NAMES);

  if (!components.ok) problems.push(...components.problems);

  if (problems.length > 0 || !components.ok) {
    throw new DomainConfigError(problems);
  }

  const { resolve } = components;

  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (const route of routes) {
    const { method, path, operationId, description, body } = route;

    const parameters = [
      ...parametersOf(route.params, "path", components),
      ...parametersOf(route.query, "query", components),
    ];

    const responses = new Map(
      [...route.responses].map(([status, described]) => [
        status,
        described === null ? null : resolve(described),
      ]),
    );

    paths[path] = {
      ...paths[path],
      [method]: {
        ...(operationId === undefined ? {} : { operationId }),
        ...(description === undefined ? {} : { description }),
        ...(parameters.length === 0 ? {} : { parameters }),
        ...(body === undefined
          ? {}
          : {
              requestBody: {
                required: true,
                content: jsonContent(resolve(body)),
              },
            }),
        responses: responsesOf(responses, body !== undefined),
      },
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title,
      version,
      ...(domain.description === undefined
        ? {}
        : { description: domain.description }),
    },
    paths,
    components: {
      schemas: {
        ...components.schemas,
        [PLATFORM_ERROR]: PLATFORM_ERROR_SCHEMA,
      },
    },
  };
}
