import { validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import domain from "../test/fixtures/domain.ts";
import { DomainConfigError } from "../src/check-domain.ts";
import type { RouteConfig } from "../src/types.ts";
import type { OpenApiDocument } from "./openapi-document.ts";
import { buildOpenApiDocument } from "./openapi-document.ts";

const document = buildOpenApiDocument(domain, { version: "1.2.3" });

// A domain of one route, `GET /v1/todos`, with nothing optional set but what `route` adds.
function buildWithListRoute(route: Partial<RouteConfig> = {}): OpenApiDocument {
  return buildOpenApiDocument(
    {
      name: "domain-a",
      routes: {
        "GET /v1/todos": {
          handler: () => undefined,
          responses: { 200: null },
          ...route,
        },
      },
    },
    { version: "1" },
  );
}

function operationOf({ paths }: OpenApiDocument, path: string, method: string) {
  const operation = paths[path]?.[method];

  if (operation === undefined)
    throw new Error(`No operation ${method} ${path}`);

  return operation;
}

describe("buildOpenApiDocument", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const { valid, errors } = await validate({ ...structuredClone(document) });

    expect(errors).toEqual([]);
    expect(valid).toBe(true);
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

  it("names the Frontdoor's server, and asks for a bearer token on every operation", () => {
    expect(document.servers).toEqual([
      {
        url: "https://{environment}.flex-domainedge.once.service.gov.uk/app/domain-a",
        variables: { environment: { default: "development" } },
      },
    ]);
    expect(document.security).toEqual([{ callerToken: [] }]);
    expect(document.components).toMatchObject({
      securitySchemes: { callerToken: { type: "http", scheme: "bearer" } },
    });
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

  it("leaves out a description or operationId not given, and a blank description", () => {
    const undescribed = buildWithListRoute();

    expect(undescribed.info).toEqual({ title: "domain-a", version: "1" });
    expect(operationOf(undescribed, "/v1/todos", "get")).not.toHaveProperty(
      "operationId",
    );

    for (const description of [undefined, "", " "]) {
      const built = buildWithListRoute(
        description === undefined ? {} : { description },
      );

      expect(operationOf(built, "/v1/todos", "get")).not.toHaveProperty(
        "description",
      );
    }
  });

  it("describes the parameters, body and declared responses", () => {
    expect(operationOf(document, "/v1/todos/{id}", "get").parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(operationOf(document, "/v1/todos", "get").parameters).toEqual([
      {
        name: "done",
        in: "query",
        required: false,
        schema: { type: "boolean" },
      },
    ]);
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
      operationOf(document, "/v1/todos/{id}", "delete").responses["204"],
    ).toEqual({
      description: "No Content",
      headers: {
        "x-correlation-id": { $ref: "#/components/headers/CorrelationId" },
      },
    });
  });

  it("describes the platform's answers on every operation, and 413 and 415 where there is a body", () => {
    const { responses } = operationOf(document, "/v1/todos/{id}", "get");

    expect(Object.keys(responses)).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "429",
      "500",
      "502",
      "503",
      "504",
    ]);
    expect(responses["403"]).not.toHaveProperty("content");
    expect(
      Object.keys(operationOf(document, "/v1/todos", "post").responses),
    ).toEqual(expect.arrayContaining(["413", "415"]));
  });

  it("describes a route's own 400 beside the platform's", () => {
    const built = buildWithListRoute({
      responses: { 200: null, 400: z.object({ code: z.string() }) },
    });

    expect(
      operationOf(built, "/v1/todos", "get").responses["400"],
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            oneOf: [
              { type: "object", properties: { code: { type: "string" } } },
              { $ref: "#/components/schemas/PlatformError" },
            ],
          },
        },
      },
    });
  });

  it("refuses a schema JSON Schema cannot hold, naming where it is", () => {
    const build = () =>
      buildWithListRoute({ responses: { 200: z.object({ due: z.date() }) } });

    expect(build).toThrow(DomainConfigError);
    expect(build).toThrow(
      'routes["GET /v1/todos"].responses[200]: cannot be described as JSON Schema',
    );
  });
});
