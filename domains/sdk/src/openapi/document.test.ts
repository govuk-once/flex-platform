import { validate } from "@scalar/openapi-parser";
import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import domain from "../../test/fixtures/domain.ts";
import { DomainConfigError } from "../check-domain.ts";
import type { RouteConfig } from "../types.ts";
import { buildOpenApiDocument } from "./document.ts";
import type { OpenApiDocument, OpenApiOperation } from "./types.ts";

const document = buildOpenApiDocument(domain, { version: "1.2.3" });

const LIST_ROUTE_AT = 'routes["GET /v1/todos"]';

// A domain of one route, `GET /v1/todos`, with nothing optional set but what `route` adds.
function buildWithListRoute(
  route: Partial<RouteConfig> = {},
  routes: Readonly<Record<string, RouteConfig>> = {},
): OpenApiDocument {
  return buildOpenApiDocument(
    {
      name: "domain-a",
      routes: {
        "GET /v1/todos": {
          handler: () => undefined,
          responses: { 200: null },
          ...route,
        },
        ...routes,
      },
    },
    { version: "1" },
  );
}

function operationOf(
  { paths }: OpenApiDocument,
  path: string,
  method: string,
): OpenApiOperation {
  const operation = paths[path]?.[method];

  assert.isDefined(operation, `no operation ${method} ${path}`);

  return operation;
}

function problemsOf(build: () => unknown): readonly string[] {
  try {
    build();
  } catch (error: unknown) {
    assert.instanceOf(error, DomainConfigError);

    return error.problems;
  }

  return [];
}

async function expectValid(doc: OpenApiDocument): Promise<void> {
  const { valid, errors } = await validate(JSON.stringify(doc));

  expect(errors).toEqual([]);
  expect(valid).toBe(true);
}

describe("buildOpenApiDocument", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    await expectValid(document);
  });

  it("describes exactly the declared operations", () => {
    expect(
      Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method} ${path}`),
      ),
    ).toEqual([
      "get /v1/todos",
      "post /v1/todos",
      "get /v1/todos/{id}",
      "patch /v1/todos/{id}",
      "delete /v1/todos/{id}",
    ]);
  });

  it("holds only the domain's parts, leaving the platform's to be added when it is published", () => {
    expect(Object.keys(document)).toEqual([
      "openapi",
      "info",
      "paths",
      "components",
    ]);
    expect(Object.keys(document.components)).toEqual(["schemas"]);
  });

  it("describes what the SDK answers by whether the route takes a body", () => {
    expect(
      Object.keys(operationOf(document, "/v1/todos", "post").responses),
    ).toContain("415");
    expect(
      Object.keys(operationOf(document, "/v1/todos", "get").responses),
    ).not.toContain("415");
  });

  it("carries the domain's description, and each route's description and operationId", () => {
    expect(document.info).toEqual({
      title: "domain-a",
      version: "1.2.3",
      description: "Domain for my todos",
    });
    expect(operationOf(document, "/v1/todos/{id}", "get")).toMatchObject({
      operationId: "getTodo",
      description: "Retrieve a single todo",
    });
  });

  it("leaves out a description or operationId not given", () => {
    const built = buildWithListRoute();

    expect(built.info).toEqual({ title: "domain-a", version: "1" });
    expect(operationOf(built, "/v1/todos", "get")).not.toHaveProperty(
      "operationId",
    );
    expect(operationOf(built, "/v1/todos", "get")).not.toHaveProperty(
      "description",
    );
  });

  it("describes path and query parameters as the route reads them", () => {
    expect(operationOf(document, "/v1/todos/{id}", "get").parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);

    const built = buildWithListRoute({
      query: z.strictObject({
        done: z.boolean(),
        tag: z.array(z.string()).optional(),
        limit: z.number().default(10),
      }),
    });

    expect(operationOf(built, "/v1/todos", "get").parameters).toEqual([
      {
        name: "done",
        in: "query",
        required: true,
        schema: { type: "boolean" },
      },
      {
        name: "tag",
        in: "query",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "number", default: 10 },
      },
    ]);
  });

  it("describes the parameters of a named params or query object", async () => {
    const built = buildOpenApiDocument(
      {
        name: "domain-a",
        routes: {
          "GET /v1/todos/{id}": {
            handler: () => undefined,
            params: z.object({ id: z.string() }).meta({ id: "TodoParams" }),
            query: z
              .strictObject({ done: z.boolean().optional() })
              .meta({ id: "TodoQuery" }),
            responses: { 200: null },
          },
        },
      },
      { version: "1" },
    );

    // The validator can't see a query parameter that is missing.
    expect(operationOf(built, "/v1/todos/{id}", "get").parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      {
        name: "done",
        in: "query",
        required: false,
        schema: { type: "boolean" },
      },
    ]);
    await expectValid(built);
  });

  it("describes a body as the request is validated, and a response as it is sent", () => {
    expect(operationOf(document, "/v1/todos", "post").requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(
      operationOf(document, "/v1/todos/{id}", "get").responses["200"]?.content,
    ).toEqual({
      "application/json": {
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            done: { type: "boolean" },
          },
          required: ["id", "title", "done"],
          additionalProperties: false,
        },
      },
    });
  });

  it("holds each named schema, recursive ones too, as a component beside the platform's failure body", async () => {
    const Tree: z.ZodType = z
      .strictObject({
        name: z.string(),
        get children() {
          return z.array(Tree);
        },
      })
      .meta({ id: "Tree" });

    const built = buildWithListRoute(
      {},
      {
        "POST /v1/trees": {
          handler: () => undefined,
          body: z.strictObject({ root: Tree }),
          responses: { 201: Tree },
        },
      },
    );

    expect(Object.keys(built.components.schemas)).toEqual([
      "Tree",
      "PlatformError",
    ]);
    expect(
      operationOf(built, "/v1/trees", "post").responses["201"]?.content,
    ).toEqual({
      "application/json": { schema: { $ref: "#/components/schemas/Tree" } },
    });
    await expectValid(built);
  });

  // Child splits, and Parent's own JSON is the same both ways.
  const Child = z
    .strictObject({ n: z.number().default(1) })
    .meta({ id: "Child" });

  const Parent = z.strictObject({ child: Child }).meta({ id: "Parent" });

  it.each<[string, Readonly<Record<string, RouteConfig>>, string]>([
    [
      "as the body and response of one route",
      {
        "POST /v1/parents": {
          handler: () => undefined,
          body: Parent,
          responses: { 201: Parent },
        },
      },
      "post",
    ],
    [
      "as a response before it is a body",
      {
        "GET /v1/parents": {
          handler: () => undefined,
          responses: { 201: Parent },
        },
        "POST /v1/parents": {
          handler: () => undefined,
          body: Parent,
          responses: { 204: null },
        },
      },
      "get",
    ],
  ])(
    "splits a named schema that holds one that splits, %s",
    async (_case, routes, sentBy) => {
      const built = buildOpenApiDocument(
        { name: "domain-a", routes },
        { version: "1" },
      );

      const { schemas } = built.components;

      expect(
        operationOf(built, "/v1/parents", "post").requestBody?.content,
      ).toEqual({
        "application/json": {
          schema: { $ref: "#/components/schemas/ParentInput" },
        },
      });
      expect(
        operationOf(built, "/v1/parents", sentBy).responses["201"]?.content,
      ).toEqual({
        "application/json": { schema: { $ref: "#/components/schemas/Parent" } },
      });
      expect(schemas).toMatchObject({
        Parent: {
          properties: { child: { $ref: "#/components/schemas/Child" } },
        },
        ParentInput: {
          properties: { child: { $ref: "#/components/schemas/ChildInput" } },
        },
        Child: { required: ["n"] },
      });
      expect(schemas["ChildInput"]).not.toHaveProperty("required");
      await expectValid(built);
    },
  );

  it.each<[string, () => unknown, readonly string[]]>([
    [
      "a configuration checkDomain refuses",
      () => buildWithListRoute({ operationId: "list-todos" }),
      [
        `${LIST_ROUTE_AT}.operationId: invalid format, must be camel case letters and digits, starting with a lowercase letter`,
      ],
    ],
    [
      "every schema it cannot describe, naming where each is",
      () =>
        buildWithListRoute(
          { responses: { 200: z.object({ due: z.date() }) } },
          {
            "POST /v1/todos": {
              handler: () => undefined,
              body: z.strictObject({ due: z.date() }),
              responses: { 201: null },
            },
          },
        ),
      [
        `${LIST_ROUTE_AT}.responses[200]: not describable as JSON Schema, use only what JSON carries, and no transform on a response`,
        'routes["POST /v1/todos"].body: not describable as JSON Schema, use only what JSON carries, and no transform on a response',
      ],
    ],
    [
      "a schema named as the platform's failure body",
      () =>
        buildWithListRoute({
          responses: {
            200: z.object({ code: z.string() }).meta({ id: "PlatformError" }),
          },
        }),
      [
        `${LIST_ROUTE_AT}.responses[200]: component name "PlatformError" already used by the platform's failure body, choose another id`,
      ],
    ],
  ])("refuses %s", (_case, build, problems) => {
    expect(problemsOf(build)).toEqual(problems);
  });
});
