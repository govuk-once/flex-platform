import type { GatewaySchemas, JSONSchema } from "@repo/gateway-types";
import { describe, expect, it } from "vitest";

import type { MetadataConfig } from "../metadata.ts";
import { bearerToken, noAuth } from "./auth.ts";
import { checkOperationSchemas } from "./check.ts";
import type { OpenApiRestGatewayConfig } from "./definition.ts";
import { openapiRest } from "./definition.ts";
import { defineHandler } from "./handler.ts";

// The mismatches a configuration and its schemas can have. Each would otherwise surface when
// the executor is created, or as an INTERNAL failure on a request that reached production.

type Auth = OpenApiRestGatewayConfig["driver"]["auth"];
// As a configuration holds an operation: the driver's fields and the handler beside them.
type Operation = OpenApiRestGatewayConfig["operations"][string];

function gateway(
  operations: Record<string, Operation>,
  auth: Auth = noAuth(),
): OpenApiRestGatewayConfig {
  return {
    id: "test",
    driver: openapiRest({ spec: "openapi.yml", auth }),
    operations,
  };
}

function withSchemas(
  input: JSONSchema,
  defs?: Record<string, JSONSchema>,
): GatewaySchemas {
  return {
    ...(defs === undefined ? {} : { defs }),
    operations: { op: { input, outcomes: { ok: { type: "object" } } } },
  };
}

// An input schema of required string fields, which is what most mappings need.
function stringFields(...names: string[]): JSONSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      names.map((name) => [name, { type: "string" }]),
    ),
    required: names,
    additionalProperties: false,
  };
}

const check = (operation: Operation, schemas: GatewaySchemas, auth?: Auth) =>
  checkOperationSchemas(gateway({ op: operation }, auth), schemas);

describe("checkOperationSchemas", () => {
  it("accepts mappings that account for every field and every placeholder", () => {
    expect(
      check(
        {
          upstream: "PATCH /v1/orgs/{orgId}/users/{id}",
          parameters: {
            orgId: { in: "path" },
            userId: { in: "path", name: "id" },
            dryRun: { in: "query" },
            etag: { in: "header", name: "if-match" },
          },
        },
        withSchemas({
          type: "object",
          properties: {
            orgId: { type: "string" },
            userId: { type: "string" },
            dryRun: { type: "boolean" },
            etag: { type: "string" },
            payload: { type: "object" },
          },
          required: ["orgId", "userId"],
        }),
      ),
    ).toEqual([]);
  });

  it("reports a placeholder no mapping fills", () => {
    expect(
      check({ upstream: "GET /v1/users/{id}" }, withSchemas(stringFields())),
    ).toEqual([
      'Operation "op": path parameter "{id}" has no parameters entry with in: "path" that names it',
    ]);
  });

  it("reports a path mapping the template does not declare", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users",
          parameters: { id: { in: "path" } },
        },
        withSchemas(stringFields("id")),
      ),
    ).toEqual([
      'Operation "op": parameter "id" names path parameter "{id}", which the template "/v1/users" does not declare',
    ]);
  });

  it("reports a mapped field the input schema does not declare", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" }, page: { in: "query" } },
        },
        withSchemas(stringFields("id")),
      ),
    ).toEqual([
      'Operation "op": parameter "page" has no field of that name in the input schema',
    ]);
  });

  it("reports a header mapping the input schema does not declare", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users",
          parameters: { etag: { in: "header", name: "if-match" } },
        },
        withSchemas(stringFields()),
      ),
    ).toEqual([
      'Operation "op": parameter "etag" has no field of that name in the input schema',
    ]);
  });

  it("reports a path parameter the input schema does not require", () => {
    // A path is built from every segment: without a value there is no request to send.
    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" } },
        },
        withSchemas({
          type: "object",
          properties: { id: { type: "string" } },
        }),
      ),
    ).toEqual([
      'Operation "op": path parameter "{id}" is filled by input field "id", which the input schema does not require',
    ]);
  });

  it("reports an input field that reaches no part of the request", () => {
    expect(
      check({ upstream: "GET /v1/users" }, withSchemas(stringFields("page"))),
    ).toEqual([
      'Operation "op": input field "page" is not mapped to the upstream request; give it a parameters entry or carry it in "payload"',
    ]);
  });

  it("accepts the payload field without a mapping", () => {
    expect(
      check(
        { upstream: "POST /v1/users" },
        withSchemas({
          type: "object",
          properties: { payload: { type: "object" } },
          required: ["payload"],
        }),
      ),
    ).toEqual([]);
  });

  it("reports a payload the method cannot carry", () => {
    expect(
      check(
        { upstream: "GET /v1/users" },
        withSchemas({
          type: "object",
          properties: { payload: { type: "object" } },
        }),
      ),
    ).toEqual([
      'Operation "op": the input schema declares "payload", which a GET request cannot carry',
    ]);
  });

  it("reports a header the gateway's authentication owns", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users",
          parameters: { token: { in: "header", name: "Authorization" } },
        },
        withSchemas(stringFields("token")),
        bearerToken(),
      ),
    ).toEqual([
      'Operation "op": parameter "token" maps to header "Authorization", which the gateway\'s authentication owns',
    ]);
  });

  it("reports a header name the transport cannot send", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users",
          parameters: { trace: { in: "header", name: "bad header" } },
        },
        withSchemas(stringFields("trace")),
      ),
    ).toEqual([
      'Operation "op" parameter "trace": "bad header" is not a valid header name',
    ]);
  });

  it("reports parameter entries the executor refuses outright", () => {
    // Nothing about these needs the schemas: they are what compileOperation throws on, said at
    // build time rather than at the first cold start after a deployment.
    expect(
      check(
        { upstream: "GET /v1/users", parameters: { "": { in: "query" } } },
        withSchemas(stringFields()),
      ),
    ).toEqual(['Operation "op": parameter fields must be non-empty']);

    expect(
      check(
        {
          upstream: "POST /v1/users",
          parameters: { payload: { in: "query" } },
        },
        withSchemas(stringFields()),
      ),
    ).toEqual([
      'Operation "op": "payload" is the request body and cannot be a parameter',
    ]);

    expect(
      check(
        {
          upstream: "GET /v1/users",
          parameters: { page: { in: "query", name: "" } },
        },
        withSchemas(stringFields("page")),
      ),
    ).toEqual(['Operation "op": parameter "page" has an empty upstream name']);
  });

  it("reports a location the driver does not know, rather than reading it as a query", () => {
    // Not reachable from typed configuration; a JavaScript caller can still write it, and the
    // executor refuses it. Read as a query parameter it would pass here and fail there.
    expect(
      check(
        {
          upstream: "GET /v1/users",
          parameters: { q: { in: "cookie" as "query" } },
        },
        withSchemas(stringFields("q")),
      ),
    ).toEqual(['Operation "op": parameter "q" has unknown location "cookie"']);
  });

  it("reports two fields that fill one path parameter", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: {
            id: { in: "path" },
            userId: { in: "path", name: "id" },
          },
        },
        withSchemas(stringFields("id", "userId")),
      ),
    ).toEqual([
      'Operation "op": path parameter "{id}" is supplied by more than one field',
    ]);
  });

  it("reports two fields that send one query parameter", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users",
          parameters: {
            page: { in: "query", name: "cursor" },
            offset: { in: "query", name: "cursor" },
          },
        },
        withSchemas(stringFields("page", "offset")),
      ),
    ).toEqual([
      'Operation "op": query parameter "cursor" is supplied by more than one field',
    ]);
  });

  it("reports two fields that send one header, whatever their case", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users",
          parameters: {
            etag: { in: "header", name: "if-match" },
            revision: { in: "header", name: "If-Match" },
          },
        },
        withSchemas(stringFields("etag", "revision")),
      ),
    ).toEqual([
      'Operation "op": header "If-Match" is supplied by more than one field',
    ]);
  });

  it("leaves an operation with a handler to build its own request", () => {
    // The executor calls a handler with the input and the client and never prepares a request
    // from the mapping, so a field the mapping does not name is not a problem here. The handler
    // may send it under any name it likes, or not at all.
    const handler = defineHandler(async () =>
      Promise.resolve({ outcome: "ok" as const, data: null }),
    );

    expect(
      check(
        { upstream: "GET /v1/things", handler },
        withSchemas(stringFields("limit")),
      ),
    ).toEqual([]);

    // The same for a mapping the handler supplies itself: it prepares a request from an object
    // it builds, so "id" is a name in that object rather than a field of the input schema.
    expect(
      check(
        {
          upstream: "GET /v1/things/{id}",
          parameters: { id: { in: "path" } },
          handler,
        },
        withSchemas(stringFields("rawId")),
      ),
    ).toEqual([]);

    // Without one the request is built from the mapping alone, and the field reaches nothing.
    expect(
      check({ upstream: "GET /v1/things" }, withSchemas(stringFields("limit"))),
    ).toEqual([
      'Operation "op": input field "limit" is not mapped to the upstream request; give it a parameters entry or carry it in "payload"',
    ]);
  });

  it("checks what a handler cannot change about an operation", () => {
    // A handler replaces the request, not the operation: the executor still compiles the
    // template and the mappings for it, so what that compilation refuses is still refused here.
    const handler = defineHandler(async () =>
      Promise.resolve({ outcome: "ok" as const, data: null }),
    );

    expect(
      check(
        {
          upstream: "GET /v1/things/{id}",
          parameters: { page: { in: "query" } },
          handler,
        },
        withSchemas(stringFields("page")),
      ),
    ).toEqual([
      'Operation "op": path parameter "{id}" has no parameters entry with in: "path" that names it',
    ]);
  });

  it("reports an upstream template that does not parse, and stops there", () => {
    expect(
      check({ upstream: "GET /v1/../admin" }, withSchemas(stringFields("id"))),
    ).toEqual([
      'Operation "op": Upstream "GET /v1/../admin" has a dot segment in its path, which the URL parser would resolve',
    ]);
  });

  it("reads an input schema through a shared definition", () => {
    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" } },
        },
        withSchemas({ $ref: "UserLookup" }, { UserLookup: stringFields("id") }),
      ),
    ).toEqual([]);
  });

  it("reports an input schema that references a definition no one declares", () => {
    expect(
      check({ upstream: "GET /v1/users" }, withSchemas({ $ref: "Missing" })),
    ).toEqual([
      'Operation "op": input schema has a "$ref" that no shared definition resolves',
    ]);
  });

  it("reads fields an input schema declares through allOf", () => {
    // Every branch of an allOf applies, so a field it declares and requires is one every valid
    // input carries.
    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" } },
        },
        withSchemas(
          {
            type: "object",
            allOf: [{ $ref: "Identified" }],
          },
          { Identified: stringFields("id") },
        ),
      ),
    ).toEqual([]);
  });

  it("reports a field declared through allOf that reaches no part of the request", () => {
    expect(
      check(
        { upstream: "GET /v1/users" },
        withSchemas({
          type: "object",
          allOf: [stringFields("page")],
        }),
      ),
    ).toEqual([
      'Operation "op": input field "page" is not mapped to the upstream request; give it a parameters entry or carry it in "payload"',
    ]);
  });

  it("takes a path parameter as required only when every branch requires it", () => {
    const branches = (...required: string[][]) => ({
      type: "object",
      anyOf: required.map((names) => stringFields(...names)),
    });

    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" } },
        },
        withSchemas(branches(["id"], ["id"])),
      ),
    ).toEqual([]);

    // One branch leaves it out, so an input can arrive without the value the path needs.
    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" } },
        },
        withSchemas({
          type: "object",
          anyOf: [stringFields("id"), stringFields()],
        }),
      ),
    ).toEqual([
      'Operation "op": path parameter "{id}" is filled by input field "id", which the input schema does not require',
    ]);
  });

  it("reads the constraints written beside a reference", () => {
    // In the 2020-12 dialect a reference's siblings apply, so a field declared there reaches
    // the request like any other.
    const base = { Base: stringFields("id") };

    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" }, extra: { in: "query" } },
        },
        withSchemas(
          {
            $ref: "Base",
            properties: { extra: { type: "string" } },
            required: ["extra"],
          },
          base,
        ),
      ),
    ).toEqual([]);

    // The same field with no mapping is one the request would not carry.
    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" } },
        },
        withSchemas(
          {
            $ref: "Base",
            properties: { extra: { type: "string" } },
            required: ["extra"],
          },
          base,
        ),
      ),
    ).toEqual([
      'Operation "op": input field "extra" is not mapped to the upstream request; give it a parameters entry or carry it in "payload"',
    ]);
  });

  it("reads a definition both branches of a composition reference", () => {
    // The same definition on two branches is a diamond, not a cycle: anyOf keeps only what
    // every branch requires, so a branch skipped as already seen would lose "id".
    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" }, hint: { in: "query" } },
        },
        withSchemas(
          {
            type: "object",
            anyOf: [
              { $ref: "Identified" },
              { $ref: "Identified", properties: { hint: { type: "string" } } },
            ],
          },
          { Identified: stringFields("id") },
        ),
      ),
    ).toEqual([]);
  });

  it("reads a chain of definitions of any length", () => {
    // Longer than any bound a depth count would have set: the chain ends, so it resolves.
    const links = Array.from({ length: 24 }, (_, index) => index);
    const defs = Object.fromEntries(
      links.map((index) => [
        `Link${String(index)}`,
        index === links.length - 1
          ? stringFields("id")
          : { $ref: `Link${String(index + 1)}` },
      ]),
    );

    expect(
      check(
        {
          upstream: "GET /v1/users/{id}",
          parameters: { id: { in: "path" } },
        },
        withSchemas({ $ref: "Link0" }, defs),
      ),
    ).toEqual([]);
  });

  it("reports a reference that comes back to a definition it is reached from", () => {
    expect(
      check(
        { upstream: "GET /v1/users" },
        withSchemas(
          { $ref: "Loop" },
          { Loop: { type: "object", allOf: [{ $ref: "Loop" }] } },
        ),
      ),
    ).toEqual([
      'Operation "op": input schema has a "$ref" that refers back to a definition it is reached from, so it declares no fields',
    ]);
  });

  it("reports a reference inside a composition that no definition resolves", () => {
    expect(
      check(
        { upstream: "GET /v1/users" },
        withSchemas({ type: "object", allOf: [{ $ref: "Missing" }] }),
      ),
    ).toEqual([
      'Operation "op": input schema has a "$ref" that no shared definition resolves',
    ]);
  });

  it("reports an input schema that is not an object", () => {
    expect(
      check({ upstream: "GET /v1/users" }, withSchemas({ type: "string" })),
    ).toEqual([
      'Operation "op": input schema must describe an object, so every field maps to part of the request',
    ]);
  });

  it("leaves an operation with no schemas to the generator", () => {
    // Codegen reports the missing set itself; repeating it here would say it twice.
    expect(
      checkOperationSchemas(gateway({ op: { upstream: "GET /v1/users" } }), {
        operations: {},
      }),
    ).toEqual([]);
  });

  it("checks every operation in one pass", () => {
    const schemas: GatewaySchemas = {
      operations: {
        first: { input: stringFields(), outcomes: { ok: {} } },
        second: { input: stringFields(), outcomes: { ok: {} } },
      },
    };

    expect(
      checkOperationSchemas(
        gateway({
          first: { upstream: "GET /v1/a/{id}" },
          second: { upstream: "GET /v1/b/{id}" },
        }),
        schemas,
      ),
    ).toHaveLength(2);
  });
});

describe("checkOperationSchemas, on what the gateway reports beside a result", () => {
  const OPERATION: Operation = { upstream: "GET /v1/users" };
  const reporting = (
    metadata: MetadataConfig,
    meta?: Record<string, JSONSchema>,
  ): readonly string[] =>
    checkOperationSchemas(
      {
        id: "test",
        driver: openapiRest({
          spec: "openapi.yml",
          auth: noAuth(),
          metadata,
        }),
        operations: { op: OPERATION },
      },
      {
        ...(meta === undefined ? {} : { meta }),
        ...withSchemas(stringFields()),
      },
    );

  it("accepts names the schemas declare and the driver reads from a header", () => {
    expect(
      reporting(
        { requestId: { header: "X-Request-Id", schema: { type: "string" } } },
        { requestId: { type: "string" } },
      ),
    ).toEqual([]);
  });

  it("reports a name only one of them knows", () => {
    expect(
      reporting(
        { requestId: { header: "X-Request-Id", schema: { type: "string" } } },
        { remaining: { type: "integer" } },
      ),
    ).toEqual([
      'metadata "remaining" is in the schemas, and the driver\'s metadata names no header to read it from',
      'metadata "requestId" is read from a header, and the schemas do not declare it',
    ]);
  });

  it("reports a header read as one type and held to another", () => {
    // The configured schema decides what the header text is read as; the stored one decides
    // what validates. A count read from "41" reaches a validator that wants a string and is
    // left out of the response, silently, since what fails validation is dropped.
    expect(
      reporting(
        { remaining: { header: "X-Remaining", schema: { type: "integer" } } },
        { remaining: { type: "string" } },
      ),
    ).toEqual([
      'metadata "remaining" is read from its header as integer, and the schemas hold it to string; what is read would not validate',
    ]);

    // An integer is a number, so one held to numbers is held to what is read.
    expect(
      reporting(
        { remaining: { header: "X-Remaining", schema: { type: "integer" } } },
        { remaining: { type: "number" } },
      ),
    ).toEqual([]);
  });

  it("reports metadata the executor would refuse to start on", () => {
    // @ts-expect-error a header is required, and the check says so of one the compiler did not see
    expect(reporting({ requestId: { schema: { type: "string" } } })).toEqual([
      'Driver metadata "requestId" must name the response header it is read from',
      'metadata "requestId" is read from a header, and the schemas do not declare it',
    ]);
  });
});
