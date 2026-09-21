import type {
  DerivedSchemas,
  OperationConfig,
  SchemaSources,
} from "@repo/gateway-config";
import type { JSONSchema } from "@repo/gateway-types";
import { describe, expect, it } from "vitest";

import type { OpenApiRestDriver, ParameterMapping } from "../index.ts";
import { openapiRest } from "../index.ts";
import { OpenApiDeriveError } from "./document.ts";
import derive from "./index.ts";

// A document of the test's own, written the way the upstreams write theirs: OpenAPI 3.0, with
// what that dialect spells differently, and its parts shared through components.
const document = (paths: object, components: object = {}) => ({
  openapi: "3.0.3",
  info: { title: "Upstream", version: "1.0.0" },
  paths,
  components,
});

const ok = (schema: object) => ({
  "200": { description: "OK", content: { "application/json": { schema } } },
});

const THING = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};

type Operations = Record<string, OperationConfig<OpenApiRestDriver>>;

function deriving(
  spec: object | string,
  operations: Operations,
): Promise<DerivedSchemas> {
  const sources: SchemaSources = {
    load: (location) =>
      location === "openapi.json"
        ? Promise.resolve(
            typeof spec === "string" ? spec : JSON.stringify(spec),
          )
        : Promise.reject(new Error(`unexpected ${location}`)),
  };
  const config = {
    id: "test",
    driver: openapiRest({ spec: "openapi.json", auth: [] }),
    operations,
  };
  return derive(config, sources);
}

async function problemsOf(run: Promise<unknown>): Promise<readonly string[]> {
  const error: unknown = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(OpenApiDeriveError);
  return (error as OpenApiDeriveError).problems;
}

describe("derive, what the driver can actually send", () => {
  const withParameter = (parameter: object) =>
    document({
      "/things": {
        get: { parameters: [parameter], responses: ok(THING) },
      },
    });
  const sending = (field: string, mapping: ParameterMapping): Operations => ({
    listThings: { upstream: "GET /things", parameters: { [field]: mapping } },
  });

  it("refuses a query parameter that is an object", async () => {
    expect(
      await problemsOf(
        deriving(
          withParameter({
            in: "query",
            name: "filter",
            schema: { type: "object", properties: { a: { type: "string" } } },
          }),
          sending("filter", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "filter" of GET /things is object, and the driver sends a scalar or an array of them there',
    ]);
  });

  it("refuses an array in a path or a header", async () => {
    for (const location of ["path", "header"] as const) {
      const name = location === "path" ? "thingId" : "x-ids";
      const template = location === "path" ? "/things/{thingId}" : "/things";
      const spec = document({
        [template]: {
          get: {
            parameters: [
              {
                in: location,
                name,
                required: true,
                schema: { type: "array", items: { type: "string" } },
              },
            ],
            responses: ok(THING),
          },
        },
      });

      expect(
        await problemsOf(
          deriving(spec, {
            listThings: {
              upstream: `GET ${template}`,
              parameters: { ids: { in: location, name } },
            },
          }),
        ),
      ).toEqual([
        `${location} parameter "${name}" of GET ${template} is array, and the driver sends one scalar there`,
      ]);
    }
  });

  it("refuses an array a query does not repeat, and a style it does not write", async () => {
    expect(
      await problemsOf(
        deriving(
          withParameter({
            in: "query",
            name: "ids",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          }),
          sending("ids", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "ids" of GET /things is an array written without exploding, and the driver repeats the name for each element',
    ]);

    expect(
      await problemsOf(
        deriving(
          withParameter({
            in: "query",
            name: "ids",
            style: "pipeDelimited",
            schema: { type: "array", items: { type: "string" } },
          }),
          sending("ids", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "ids" of GET /things is serialised as "pipeDelimited", and the driver writes a query as "form"',
    ]);
  });

  it("refuses reserved characters sent unencoded", async () => {
    expect(
      await problemsOf(
        deriving(
          withParameter({
            in: "query",
            name: "path",
            allowReserved: true,
            schema: { type: "string" },
          }),
          sending("path", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "path" of GET /things asks for reserved characters to go unencoded, and the driver encodes them',
    ]);
  });

  it("reads the type through a reference and a composition", async () => {
    expect(
      await problemsOf(
        deriving(
          document(
            {
              "/things": {
                get: {
                  parameters: [
                    {
                      in: "query",
                      name: "filter",
                      schema: { $ref: "#/components/schemas/Filter" },
                    },
                  ],
                  responses: ok(THING),
                },
              },
            },
            { schemas: { Filter: { type: "object" } } },
          ),
          sending("filter", { in: "query" }),
        ),
      ),
    ).toContain(
      'query parameter "filter" of GET /things is object, and the driver sends a scalar or an array of them there',
    );

    expect(
      await problemsOf(
        deriving(
          document(
            {
              "/things": {
                get: {
                  parameters: [
                    {
                      in: "query",
                      name: "filter",
                      schema: {
                        allOf: [{ $ref: "#/components/schemas/Filter" }],
                      },
                    },
                  ],
                  responses: ok(THING),
                },
              },
            },
            { schemas: { Filter: { type: "object" } } },
          ),
          sending("filter", { in: "query" }),
        ),
      ),
    ).toContain(
      'query parameter "filter" of GET /things is object, and the driver sends a scalar or an array of them there',
    );
  });

  it("takes a query array whose style says what the driver writes", async () => {
    const { schemas } = await deriving(
      withParameter({
        in: "query",
        name: "ids",
        style: "form",
        explode: true,
        schema: { type: "array", items: { type: "string" } },
      }),
      sending("ids", { in: "query" }),
    );

    expect(schemas.operations.listThings?.input).toMatchObject({
      properties: { ids: { type: "array", items: { type: "string" } } },
    });
  });

  it("refuses a query array the driver cannot write element by element", async () => {
    expect(
      await problemsOf(
        deriving(
          withParameter({
            in: "query",
            name: "ids",
            schema: { type: "array", items: { type: "object" } },
          }),
          sending("ids", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "ids" of GET /things is an array of object, and the driver writes each element as one scalar',
    ]);

    expect(
      await problemsOf(
        deriving(
          withParameter({
            in: "query",
            name: "ids",
            // 3.0 spells it this way; the parser refuses a list of types in that dialect.
            schema: {
              type: "array",
              items: { type: "string", nullable: true },
            },
          }),
          sending("ids", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "ids" of GET /things is an array of null, and the driver writes each element as one scalar',
    ]);
  });

  it("reads the type a parameter's keywords give it, where it declares none", async () => {
    // The validators are generated from a schema those keywords give the type to, so a check
    // that read only what was written would let an object through as untyped.
    expect(
      await problemsOf(
        deriving(
          withParameter({
            in: "query",
            name: "filter",
            schema: { properties: { a: { type: "string" } } },
          }),
          sending("filter", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "filter" of GET /things is object, and the driver sends a scalar or an array of them there',
    ]);
  });

  it("refuses a required parameter that admits null", async () => {
    // In a path null is not a value at all; elsewhere it is how a caller leaves a parameter
    // out, which a required one may not be. A path parameter is always required.
    expect(
      await problemsOf(
        deriving(
          document({
            "/things/{thingId}": {
              get: {
                parameters: [
                  {
                    in: "path",
                    name: "thingId",
                    required: true,
                    schema: { type: "string", nullable: true },
                  },
                ],
                responses: ok(THING),
              },
            },
          }),
          {
            getThing: {
              upstream: "GET /things/{thingId}",
              parameters: { thingId: { in: "path" } },
            },
          },
        ),
      ),
    ).toEqual([
      'path parameter "thingId" of GET /things/{thingId} is required and admits null, which the driver does not send: null leaves a parameter out',
    ]);

    // Optional, null is how a caller says to leave it out, which the driver does.
    const { schemas } = await deriving(
      withParameter({
        in: "query",
        name: "since",
        schema: { type: "string", nullable: true },
      }),
      sending("since", { in: "query" }),
    );
    expect(schemas.operations.listThings?.input).toMatchObject({
      properties: { since: { type: ["string", "null"] } },
    });
  });

  it("refuses a required query array that admits one with nothing in it", async () => {
    // The driver writes the name once per element, so an empty array writes no name at all and
    // the upstream sees a request without the parameter. A validator that admitted the value
    // has already let the call through, which is the absence null leaves, by another route.
    const required = (schema: object) => ({
      in: "query",
      name: "ids",
      required: true,
      schema,
    });
    const refused =
      'query parameter "ids" of GET /things is required and admits an array with nothing in it, which the driver does not send: an empty array leaves a parameter out';

    expect(
      await problemsOf(
        deriving(
          withParameter(required({ type: "array", items: { type: "string" } })),
          sending("ids", { in: "query" }),
        ),
      ),
    ).toEqual([refused]);

    // Behind a name, and among branches: what a schema comes to is read through both.
    expect(
      await problemsOf(
        deriving(
          document(
            {
              "/things": {
                get: {
                  parameters: [required({ $ref: "#/components/schemas/Ids" })],
                  responses: ok(THING),
                },
              },
            },
            {
              schemas: {
                Ids: { type: "array", items: { type: "string" } },
              },
            },
          ),
          sending("ids", { in: "query" }),
        ),
      ),
    ).toEqual([refused]);

    expect(
      await problemsOf(
        deriving(
          withParameter(
            required({
              oneOf: [
                { type: "array", items: { type: "string" }, minItems: 1 },
                { type: "array", items: { type: "string" } },
              ],
            }),
          ),
          sending("ids", { in: "query" }),
        ),
      ),
    ).toEqual([refused]);
  });

  it("takes a query array that has to hold something, and lets an optional one be empty", async () => {
    // `minItems` says the array is never empty, wherever it is written.
    for (const schema of [
      { type: "array", items: { type: "string" }, minItems: 1 },
      {
        allOf: [{ type: "array", items: { type: "string" } }, { minItems: 2 }],
      },
    ]) {
      await expect(
        deriving(
          withParameter({
            in: "query",
            name: "ids",
            required: true,
            schema,
          }),
          sending("ids", { in: "query" }),
        ),
        JSON.stringify(schema),
      ).resolves.toBeDefined();
    }

    // `contains` wants a match among the elements, which an array with nothing in it cannot
    // supply. 3.0 does not have the keyword, so the document says it is 3.1.
    await expect(
      deriving(
        {
          openapi: "3.1.0",
          info: { title: "Upstream", version: "1.0.0" },
          paths: {
            "/things": {
              get: {
                parameters: [
                  {
                    in: "query",
                    name: "ids",
                    required: true,
                    schema: {
                      type: "array",
                      items: { type: "string" },
                      contains: { type: "string", minLength: 1 },
                    },
                  },
                ],
                responses: ok(THING),
              },
            },
          },
        },
        sending("ids", { in: "query" }),
      ),
    ).resolves.toBeDefined();

    // Optional, an empty array says the same as leaving it out, which is what the driver sends.
    await expect(
      deriving(
        withParameter({
          in: "query",
          name: "ids",
          schema: { type: "array", items: { type: "string" } },
        }),
        sending("ids", { in: "query" }),
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a branch that constrains nothing, however narrow the others are", async () => {
    // A branch admitting every value is not nothing: it admits what the others exclude, and a
    // union holding one is a parameter that could arrive as an object.
    const unconstrained = { anyOf: [{ type: "string" }, {}] };

    expect(
      await problemsOf(
        deriving(
          withParameter({ in: "query", name: "v", schema: unconstrained }),
          sending("v", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "v" of GET /things admits a value of any type, so what the driver would have to send cannot be read',
    ]);

    expect(
      await problemsOf(
        deriving(
          withParameter({
            in: "query",
            name: "v",
            schema: { type: "array", items: unconstrained },
          }),
          sending("v", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "v" of GET /things is an array whose elements are not all described, so what the driver would have to send cannot be read',
    ]);
  });

  it("refuses a tuple whose tail nothing describes, and takes one that ends", async () => {
    // `prefixItems` names the elements at the front; `items` describes the rest, and left out
    // there is nothing to hold them to. Written as 3.1, which is the dialect that has them.
    const tuple = (schema: object) => ({
      openapi: "3.1.0",
      info: { title: "Upstream", version: "1.0.0" },
      paths: {
        "/things": {
          get: {
            parameters: [{ in: "query", name: "v", schema }],
            responses: ok(THING),
          },
        },
      },
    });

    expect(
      await problemsOf(
        deriving(
          tuple({ type: "array", prefixItems: [{ type: "string" }] }),
          sending("v", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "v" of GET /things is an array whose elements are not all described, so what the driver would have to send cannot be read',
    ]);

    // `items: false` is how a tuple says it ends, and every element it names is a scalar.
    await expect(
      deriving(
        tuple({
          type: "array",
          prefixItems: [{ type: "string" }],
          items: false,
        }),
        sending("v", { in: "query" }),
      ),
    ).resolves.toBeDefined();
  });

  it("reads an array's elements branch by branch, as the branches are combined", async () => {
    // An array whose elements nothing describes admits every element. Beside one that admits
    // strings, a union admits every element and an `allOf` admits strings: taking the silence
    // for the other branch's restriction, or for no restriction at all, reads one of the two
    // the wrong way round.
    const arrayOf = (items?: object) =>
      items === undefined ? { type: "array" } : { type: "array", items };
    // Written as 3.1: 3.0 wants an array to name its elements, which is the case at issue.
    const parameter = (schema: object) =>
      deriving(
        {
          openapi: "3.1.0",
          info: { title: "Upstream", version: "1.0.0" },
          paths: {
            "/things": {
              get: {
                parameters: [{ in: "query", name: "v", schema }],
                responses: ok(THING),
              },
            },
          },
        },
        sending("v", { in: "query" }),
      );
    const undescribed =
      'query parameter "v" of GET /things is an array whose elements are not all described, so what the driver would have to send cannot be read';

    for (const key of ["anyOf", "oneOf"]) {
      expect(
        await problemsOf(
          parameter({ [key]: [arrayOf({ type: "string" }), arrayOf()] }),
        ),
        key,
      ).toEqual([undescribed]);
    }

    // Held to both at once, the elements are what both admit.
    await expect(
      parameter({ allOf: [arrayOf({}), arrayOf({ type: "string" })] }),
    ).resolves.toBeDefined();
    // Two branches that each describe their elements describe the union's.
    await expect(
      parameter({
        anyOf: [arrayOf({ type: "string" }), arrayOf({ type: "integer" })],
      }),
    ).resolves.toBeDefined();
    // A branch that is no array says nothing of elements, and its silence is not a restriction.
    await expect(
      parameter({ anyOf: [arrayOf({ type: "string" }), { type: "null" }] }),
    ).resolves.toBeDefined();

    // A schema that constrains nothing constrains nothing about what an array holds either,
    // and says so whichever of its two spellings it is written in: an empty element domain
    // would be the opposite, and would take another part's restriction with it under an
    // `allOf` and add nothing to it under an `anyOf`.
    for (const open of [true, {}]) {
      const spelling = JSON.stringify(open);
      expect(
        await problemsOf(
          parameter({ allOf: [arrayOf({ type: "object" }), open] }),
        ),
        spelling,
      ).toEqual([
        'query parameter "v" of GET /things is an array of object, and the driver writes each element as one scalar',
      ]);
      expect(
        await problemsOf(
          parameter({
            type: "array",
            anyOf: [arrayOf({ type: "string" }), open],
          }),
        ),
        spelling,
      ).toEqual([undescribed]);
    }
  });

  it("reads a parameter as the conversion left it, not as the document wrote it", async () => {
    // The validators are generated from the converted schema, where a keyword the declared type
    // says nothing about has gone. Read from the document instead, this is an object.
    await expect(
      deriving(
        withParameter({
          in: "query",
          name: "v",
          schema: { type: "string", additionalProperties: false },
        }),
        sending("v", { in: "query" }),
      ),
    ).resolves.toBeDefined();

    // And a part of an `allOf` that only describes the whole leaves the type the others name.
    await expect(
      deriving(
        document(
          {
            "/things": {
              get: {
                parameters: [
                  {
                    in: "query",
                    name: "v",
                    schema: {
                      allOf: [
                        { $ref: "#/components/schemas/Id" },
                        { description: "an id" },
                      ],
                    },
                  },
                ],
                responses: ok(THING),
              },
            },
          },
          { schemas: { Id: { type: "string" } } },
        ),
        sending("v", { in: "query" }),
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a parameter that refers to itself rather than following it", async () => {
    expect(
      await problemsOf(
        deriving(
          document(
            {
              "/things": {
                get: {
                  parameters: [
                    {
                      in: "query",
                      name: "v",
                      schema: { $ref: "#/components/schemas/Tree" },
                    },
                  ],
                  responses: ok(THING),
                },
              },
            },
            {
              schemas: {
                Tree: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Tree" },
                },
              },
            },
          ),
          sending("v", { in: "query" }),
        ),
      ),
    ).toContain(
      'query parameter "v" of GET /things refers to itself, and the driver has one scalar to send there',
    );
  });

  it("refuses a parameter whose shape cannot be read at all", async () => {
    expect(
      await problemsOf(
        deriving(
          withParameter({ in: "query", name: "anything", schema: {} }),
          sending("anything", { in: "query" }),
        ),
      ),
    ).toEqual([
      'query parameter "anything" of GET /things admits a value of any type, so what the driver would have to send cannot be read',
    ]);
  });

  it("refuses a required cookie, and notes one that is not", async () => {
    const cookie = (required: boolean) =>
      deriving(
        withParameter({
          in: "cookie",
          name: "session",
          required,
          schema: { type: "string" },
        }),
        { listThings: { upstream: "GET /things" } },
      );

    expect(await problemsOf(cookie(true))).toEqual([
      'cookie parameter "session" of GET /things is a required cookie, and a gateway sends none',
    ]);
    const { notes } = await cookie(false);
    expect(notes).toContain(
      'cookie parameter "session" of GET /things is a cookie, which a gateway does not send',
    );
  });
});

describe("derive, an operation's input", () => {
  const paths = {
    "/things/{thingId}": {
      parameters: [
        {
          name: "thingId",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1 },
        },
      ],
      get: {
        parameters: [
          {
            name: "include",
            in: "query",
            description: "What to bring back with it",
            schema: { type: "string", enum: ["all", "none"], example: "all" },
          },
          {
            name: "X-Requesting-Service",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: ok(THING),
      },
    },
  };

  it("is one closed object: a field for each parameter the configuration maps, under its name for it", async () => {
    const { schemas, notes } = await deriving(document(paths), {
      getThing: {
        upstream: "GET /things/{thingId}",
        parameters: {
          thingId: { in: "path" },
          include: { in: "query" },
          service: { in: "header", name: "x-requesting-service" },
        },
      },
    });

    expect(schemas.operations.getThing?.input).toEqual({
      type: "object",
      properties: {
        thingId: { type: "string", minLength: 1 },
        include: {
          type: "string",
          enum: ["all", "none"],
          description: "What to bring back with it",
        },
        service: { type: "string" },
      },
      required: ["thingId", "service"],
      additionalProperties: false,
    });
    expect(notes).toEqual([]);
  });

  it("says which optional parameter a gateway chose not to offer, and refuses to leave a required one out", async () => {
    const { notes } = await deriving(document(paths), {
      getThing: {
        upstream: "GET /things/{thingId}",
        parameters: {
          thingId: { in: "path" },
          service: { in: "header", name: "X-Requesting-Service" },
        },
      },
    });
    expect(notes).toEqual([
      'query parameter "include" of GET /things/{thingId} is optional and operation "getThing" maps no input field to it, so callers cannot send it',
    ]);

    expect(
      await problemsOf(
        deriving(document(paths), {
          getThing: {
            upstream: "GET /things/{thingId}",
            parameters: { thingId: { in: "path" }, colour: { in: "query" } },
          },
        }),
      ),
    ).toEqual([
      'operation "getThing" sends field "colour" as query parameter "colour", which GET /things/{thingId} does not declare',
      'header parameter "X-Requesting-Service" of GET /things/{thingId} is required, and operation "getThing" maps no input field to it',
    ]);
  });

  it("carries a body under payload, required whatever the document says of it", async () => {
    const body = (requestBody: object) =>
      document({ "/things": { post: { requestBody, responses: ok(THING) } } });
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const expected = {
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
      },
      required: ["payload"],
      additionalProperties: false,
    };

    for (const requestBody of [
      { content: { "application/json": { schema } } },
      { required: false, content: { "application/json": { schema } } },
      // Offered under both, the one the driver sends is the one it is derived from.
      {
        required: true,
        content: {
          "application/merge-patch+json": { schema: { type: "string" } },
          "application/json": { schema },
        },
      },
    ]) {
      const { schemas } = await deriving(body(requestBody), {
        createThing: { upstream: "POST /things" },
      });
      expect(schemas.operations.createThing?.input).toEqual(expected);
    }
  });

  it("refuses a body offered only under a type the driver does not send", async () => {
    // Derived from the merge-patch schema and sent as application/json, the request would not
    // be the one the document describes: a server reading a merge patch takes null for "remove
    // this field", and the same bytes under application/json mean a field set to null.
    expect(
      await problemsOf(
        deriving(
          document({
            "/things": {
              patch: {
                requestBody: {
                  content: {
                    "application/merge-patch+json": {
                      schema: { type: "object" },
                    },
                  },
                },
                responses: ok(THING),
              },
            },
          }),
          { patchThing: { upstream: "PATCH /things" } },
        ),
      ),
    ).toEqual([
      'PATCH /things takes a request body the driver cannot send: it is offered under "application/merge-patch+json" and the driver sends application/json',
    ]);

    expect(
      await problemsOf(
        deriving(
          document({
            "/things": {
              post: {
                requestBody: {
                  content: { "text/csv": { schema: { type: "string" } } },
                },
                responses: ok(THING),
              },
            },
          }),
          { createThing: { upstream: "POST /things" } },
        ),
      ),
    ).toEqual([
      'POST /things takes a request body the driver cannot send: it is offered under "text/csv" and the driver sends application/json',
    ]);
  });
});

describe("derive, an operation's outcomes", () => {
  const answering = (responses: object) =>
    deriving(document({ "/things": { post: { responses } } }), {
      createThing: { upstream: "POST /things" },
    });
  const json = (schema: object) => ({
    description: "",
    content: { "application/json": { schema } },
  });

  it("names each by the status the driver maps to it, and leaves the errors to their codes", async () => {
    const { schemas } = await answering({
      "200": json(THING),
      "201": json(THING),
      "202": { description: "Accepted" },
      "400": json({
        type: "object",
        properties: { errorCode: { type: "number" } },
      }),
      "404": json(THING),
      "500": json(THING),
      default: json(THING),
    });

    expect(schemas.operations.createThing?.outcomes).toEqual({
      ok: THING,
      created: THING,
      accepted: { type: "null" },
    });
  });

  it("has no data for a 204, whatever body the document gives it", async () => {
    const { schemas, notes } = await answering({
      "204": json({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    });

    expect(schemas.operations.createThing?.outcomes).toEqual({
      no_content: { type: "null" },
    });
    expect(notes).toEqual([
      "POST /things describes a body for its 204, which has none; it was left out",
    ]);
  });

  it("refuses an operation it can name no outcome for, and says which success it cannot map", async () => {
    expect(await problemsOf(answering({ "400": json(THING) }))).toEqual([
      "POST /things describes no response the driver maps to an outcome (200, 201, 202 or 204)",
    ]);
    expect(
      await problemsOf(
        answering({
          "200": { description: "", content: { "text/plain": { schema: {} } } },
        }),
      ),
    ).toContain("POST /things answers 200 with a body that is not JSON");

    const { notes } = await answering({
      "200": json(THING),
      "206": json(THING),
    });
    expect(notes).toEqual([
      "POST /things answers 206, which the driver maps to no outcome; a response with it fails",
    ]);
  });
});

describe("derive, a path the document leaves to a template that takes any", () => {
  const BAG = {
    type: "object",
    properties: {},
    additionalProperties: { nullable: true },
  };
  const STORE = {
    "/v1/sar/{sarId}": {
      get: {
        parameters: [
          {
            name: "sarId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: ok(THING),
      },
    },
    "/v1/{resourcePath+}": {
      get: {
        parameters: [
          {
            name: "resourcePath",
            in: "path",
            required: true,
            schema: { type: "string", minLength: 1 },
          },
          {
            name: "requesting-service",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: ok({
          type: "object",
          properties: { data: BAG },
          required: ["data"],
        }),
      },
      post: {
        parameters: [
          {
            name: "resourcePath",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: BAG,
                  configuration: {
                    type: "object",
                    properties: { ttl: { type: "integer" } },
                  },
                },
                required: ["data"],
              },
            },
          },
        },
        responses: ok(BAG),
      },
    },
  };
  const HEADER: Record<string, ParameterMapping> = {
    "requesting-service": { in: "header" },
  };

  it("derives from the template an operation says serves its path, which fills the template's parameter", async () => {
    const { schemas, notes } = await deriving(document(STORE), {
      getNotifications: {
        upstream: "GET /v1/notifications",
        matches: "/v1/{resourcePath+}",
        parameters: HEADER,
      },
    });

    // No `resourcePath` for a caller to supply: the operation's own path is what it is.
    expect(schemas.operations.getNotifications).toEqual({
      input: {
        type: "object",
        properties: { "requesting-service": { type: "string" } },
        required: ["requesting-service"],
        additionalProperties: false,
      },
      outcomes: {
        ok: {
          type: "object",
          properties: {
            data: { type: "object", properties: {}, additionalProperties: {} },
          },
          required: ["data"],
        },
      },
    });
    expect(notes).toEqual([
      'path parameter "resourcePath" of /v1/{resourcePath+} is "notifications" for operation "getNotifications", from its own path; no caller supplies it',
    ]);
  });

  it("refuses a path the document lacks unless the operation says what serves it, and says what could", async () => {
    expect(
      await problemsOf(
        deriving(document(STORE), {
          getNotifications: {
            upstream: "GET /v1/notifications",
            parameters: HEADER,
          },
        }),
      ),
    ).toEqual([
      'operation "getNotifications" is GET /v1/notifications, which the document does not describe; if "/v1/{resourcePath+}" is meant to serve it, say so as the operation\'s "matches"',
    ]);
  });

  it.each<[string, OperationConfig<OpenApiRestDriver>, RegExp]>([
    [
      "a path the document declares itself",
      {
        upstream: "GET /v1/sar/{sarId}",
        matches: "/v1/{resourcePath+}",
        parameters: { sarId: { in: "path" } },
      },
      /the document declares that path itself/,
    ],
    [
      "a template the document does not have",
      { upstream: "GET /v1/notifications", matches: "/v2/{anything+}" },
      /which is not a path of the document/,
    ],
    [
      "a template the path does not fit",
      { upstream: "GET /v2/notifications", matches: "/v1/{resourcePath+}" },
      /which it does not: its segment 1 is not "v1"/,
    ],
    [
      "a path a more specific template would be routed to",
      {
        upstream: "GET /v1/sar/abc",
        matches: "/v1/{resourcePath+}",
        parameters: HEADER,
      },
      /the upstream would route it to "\/v1\/sar\/\{sarId\}", which is more specific/,
    ],
    [
      "a path with a trailing slash, which a router may drop",
      {
        upstream: "GET /v1/sar/abc/",
        matches: "/v1/{resourcePath+}",
        parameters: HEADER,
      },
      /which it does not: its segment 4 is empty, which a router may drop or merge with the next/,
    ],
    [
      "a path with a slash written inside a segment",
      {
        upstream: "GET /v1/sar%2Fabc",
        matches: "/v1/{resourcePath+}",
        parameters: HEADER,
      },
      /which it does not: its segment 2 writes a slash or a backslash inside it/,
    ],
    [
      "a method the template does not take",
      { upstream: "DELETE /v1/notifications", matches: "/v1/{resourcePath+}" },
      /"\/v1\/\{resourcePath\+\}" does not take DELETE/,
    ],
    [
      "a caller's own parameter where the template takes the rest of the path",
      {
        upstream: "GET /v1/things/{id}",
        matches: "/v1/{resourcePath+}",
        parameters: { id: { in: "path" } },
      },
      /has to be written out, and "\{id\}" is a parameter/,
    ],
  ])("refuses `matches` for %s", async (_what, operation, problem) => {
    const [first] = await problemsOf(
      deriving(document(STORE), { op: operation }),
    );

    expect(first).toMatch(problem);
  });

  it("fills an ordinary parameter with a segment written out, and carries one the path keeps", async () => {
    const { schemas } = await deriving(
      document({
        "/v1/identity/{serviceName}/{identifier}": {
          get: {
            parameters: [
              {
                name: "serviceName",
                in: "path",
                required: true,
                schema: { type: "string", enum: ["app", "dvla"] },
              },
              {
                name: "identifier",
                in: "path",
                required: true,
                schema: { type: "string", minLength: 1 },
              },
            ],
            responses: ok(THING),
          },
        },
      }),
      {
        getAppIdentity: {
          upstream: "GET /v1/identity/app/{id}",
          matches: "/v1/identity/{serviceName}/{identifier}",
          parameters: { id: { in: "path" } },
        },
      },
    );

    expect(schemas.operations.getAppIdentity?.input).toEqual({
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("refuses a segment the document does not list for the parameter it fills", async () => {
    const paths = {
      "/v1/identity/{serviceName}": {
        get: {
          parameters: [
            {
              name: "serviceName",
              in: "path",
              required: true,
              schema: { type: "string", enum: ["app"] },
            },
          ],
          responses: ok(THING),
        },
      },
    };

    expect(
      await problemsOf(
        deriving(document(paths), {
          op: {
            upstream: "GET /v1/identity/other",
            matches: "/v1/identity/{serviceName}",
          },
        }),
      ),
    ).toEqual([
      'GET /v1/identity/other fills path parameter "serviceName" with "other", which the document does not admit there: must be equal to one of the allowed values',
    ]);
  });

  describe("and what the operation states of the shape kept there", () => {
    const NOTIFICATIONS = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            consentStatus: {
              type: "string",
              enum: ["unknown", "accepted", "denied"],
            },
            pushId: { type: "string", minLength: 1 },
          },
          required: ["consentStatus"],
          additionalProperties: false,
        },
      },
    };

    it("sets it into what the document says, strict for a body and held to its shape for an outcome", async () => {
      const { schemas } = await deriving(document(STORE), {
        getNotifications: {
          upstream: "GET /v1/notifications",
          matches: "/v1/{resourcePath+}",
          parameters: HEADER,
          narrow: { outcomes: { ok: NOTIFICATIONS } },
        },
        updateNotifications: {
          upstream: "POST /v1/notifications",
          matches: "/v1/{resourcePath+}",
          narrow: { payload: NOTIFICATIONS },
        },
      });

      // The body: what the document says, closed where it said nothing, with ours set into it
      // as written where the document said only "an object".
      expect(schemas.operations.updateNotifications?.input.properties).toEqual({
        payload: {
          type: "object",
          properties: {
            data: NOTIFICATIONS.properties.data,
            configuration: {
              type: "object",
              properties: { ttl: { type: "integer" } },
              additionalProperties: false,
            },
          },
          required: ["data"],
          additionalProperties: false,
        },
      });
      // The outcome: ours as any outcome is held, open to what is added and to values not yet
      // known, and with no bound on what a field holds.
      expect(schemas.operations.getNotifications?.outcomes.ok).toEqual({
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              consentStatus: {
                anyOf: [
                  { enum: ["unknown", "accepted", "denied"] },
                  { type: "string" },
                ],
              },
              pushId: { type: "string" },
            },
            required: ["consentStatus"],
          },
        },
        required: ["data"],
      });
    });

    // What `narrow` can hold in a configuration nothing typechecked: derivation reads it as data,
    // so these include values the type refuses.
    it.each<[string, { readonly narrow: unknown }, RegExp]>([
      [
        "a body the operation does not take",
        { narrow: { payload: NOTIFICATIONS } },
        /narrows a request body, and GET \/v1\/notifications takes none/,
      ],
      [
        "an outcome it does not have",
        { narrow: { outcomes: { created: NOTIFICATIONS } } },
        /narrows outcome "created"/,
      ],
      [
        "a field it does not know",
        { narrow: { outcome: {} } },
        /has an unknown field "outcome"/,
      ],
      [
        "a reference, which has nothing to refer to",
        { narrow: { outcomes: { ok: { $ref: "Thing" } } } },
        /must be written out/,
      ],
      [
        "a reference inside a composition it is written with",
        {
          narrow: {
            outcomes: {
              ok: {
                type: "object",
                allOf: [{ $ref: "#/components/schemas/Thing" }],
              },
            },
          },
        },
        /allOf\.0 must be written out/,
      ],
      [
        "a reference inside one of its fields",
        {
          narrow: {
            outcomes: {
              ok: { type: "object", properties: { a: { $ref: "Thing" } } },
            },
          },
        },
        /properties\.a must be written out/,
      ],
      [
        "what is not a schema",
        { narrow: { outcomes: { ok: "object" } } },
        /must be a schema object/,
      ],
      [
        "with a keyword written as something other than what it takes",
        { narrow: { outcomes: { ok: { type: "object", required: "id" } } } },
        /required must be a list of field names/,
      ],
      [
        "with fields written as something other than an object of schemas",
        { narrow: { outcomes: { ok: { type: "object", properties: [] } } } },
        /properties must be an object of schemas/,
      ],
      [
        "with a name an object literal would read as its prototype",
        {
          // Written as text: an object literal would set the prototype rather than declare a
          // field, which is the difference this is here to keep.
          narrow: {
            outcomes: {
              ok: JSON.parse(
                '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
              ) as object,
            },
          },
        },
        /cannot declare "__proto__"/,
      ],
    ])("refuses to narrow %s", async (_what, extra, problem) => {
      const problems = await problemsOf(
        deriving(document(STORE), {
          getNotifications: {
            upstream: "GET /v1/notifications",
            matches: "/v1/{resourcePath+}",
            parameters: HEADER,
            ...extra,
          } as OperationConfig<OpenApiRestDriver>,
        }),
      );

      expect(problems.join("\n")).toMatch(problem);
    });

    it("leaves a value that is written like a reference as the value it is", async () => {
      // A definition both sides hold differently is kept twice and the references to it are
      // rewritten to the side's name. A `const` or an `enum` holds values, not references: a
      // value whose key happens to be "$ref" is the object the caller has to send, and rewriting
      // it would make the value the document named fail and one it never named pass.
      const { schemas } = await deriving(
        document(
          {
            ...STORE,
            "/v1/things": {
              put: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Thing" },
                    },
                  },
                },
                responses: ok({ $ref: "#/components/schemas/Thing" }),
              },
            },
          },
          {
            schemas: {
              Thing: {
                type: "object",
                properties: { status: { type: "string", enum: ["a"] } },
              },
            },
          },
        ),
        {
          putThing: { upstream: "PUT /v1/things" },
          updateNotifications: {
            upstream: "POST /v1/notifications",
            matches: "/v1/{resourcePath+}",
            narrow: {
              payload: {
                type: "object",
                properties: {
                  data: {
                    type: "object",
                    properties: { marker: { enum: [{ $ref: "Thing" }] } },
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      );

      // The definition did split, so there is a name to have been rewritten to.
      expect(Object.keys(schemas.defs ?? {})).toEqual(["Thing", "ThingInput"]);
      expect(
        schemas.operations.updateNotifications?.input.properties,
      ).toMatchObject({
        payload: {
          properties: {
            data: { properties: { marker: { enum: [{ $ref: "Thing" }] } } },
          },
        },
      });
    });
  });
});

describe("derive, the document", () => {
  it("reads the parts an upstream shares through its components", async () => {
    const { schemas } = await deriving(
      document(
        {
          "/things": {
            post: {
              parameters: [{ $ref: "#/components/parameters/correlation" }],
              requestBody: { $ref: "#/components/requestBodies/Thing" },
              responses: { "201": { $ref: "#/components/responses/Made" } },
            },
          },
        },
        {
          parameters: {
            correlation: {
              name: "X-Correlation-ID",
              in: "header",
              schema: { type: "string" },
            },
          },
          requestBodies: {
            Thing: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Thing" },
                },
              },
            },
          },
          responses: {
            Made: {
              description: "Made",
              headers: {
                "X-Request-Id": { $ref: "#/components/headers/requestId" },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Made" },
                },
              },
            },
          },
          headers: { requestId: { schema: { type: "string" } } },
          schemas: {
            Unused: { type: "string" },
            Made: { type: "object", properties: { id: { type: "string" } } },
            Thing: { type: "object", properties: { name: { type: "string" } } },
          },
        },
      ),
      {
        createThing: {
          upstream: "POST /things",
          parameters: {
            correlationId: { in: "header", name: "X-Correlation-ID" },
          },
        },
      },
    );

    expect(schemas).toEqual({
      // Only what an input or an outcome reaches, in the order the document declares them.
      defs: {
        Made: { type: "object", properties: { id: { type: "string" } } },
        Thing: {
          type: "object",
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
      },
      operations: {
        createThing: {
          input: {
            type: "object",
            properties: {
              correlationId: { type: "string" },
              payload: { $ref: "Thing" },
            },
            required: ["payload"],
            additionalProperties: false,
          },
          outcomes: { created: { $ref: "Made" } },
        },
      },
    });
  });

  it("gives an input a definition of its own where the two sides hold one differently", async () => {
    const { schemas, notes } = await deriving(
      document(
        {
          "/things": {
            put: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Wrapper" },
                  },
                },
              },
              responses: ok({ $ref: "#/components/schemas/Wrapper" }),
            },
          },
        },
        {
          schemas: {
            Wrapper: {
              type: "object",
              properties: {
                thing: { $ref: "#/components/schemas/Thing" },
                id: { $ref: "#/components/schemas/Id" },
              },
            },
            Thing: {
              type: "object",
              properties: { status: { type: "string", enum: ["a"] } },
            },
            Id: { type: "string" },
          },
        },
      ),
      { putThing: { upstream: "PUT /things" } },
    );

    expect(Object.keys(schemas.defs ?? {})).toEqual([
      "Wrapper",
      "WrapperInput",
      "Thing",
      "ThingInput",
      "Id",
    ]);
    expect(schemas.defs?.ThingInput).toEqual({
      type: "object",
      properties: { status: { type: "string", enum: ["a"] } },
      additionalProperties: false,
    });
    expect(schemas.defs?.Thing).toEqual({
      type: "object",
      properties: { status: { anyOf: [{ enum: ["a"] }, { type: "string" }] } },
    });
    // Held the same on both sides, so it is one definition, referred to by both.
    expect(schemas.defs?.WrapperInput).toMatchObject({
      properties: { thing: { $ref: "ThingInput" }, id: { $ref: "Id" } },
    });
    expect(schemas.operations.putThing).toEqual({
      input: {
        type: "object",
        properties: { payload: { $ref: "WrapperInput" } },
        required: ["payload"],
        additionalProperties: false,
      },
      outcomes: { ok: { $ref: "Wrapper" } },
    });
    expect(notes).toContain(
      'schema "Thing" is used by an input and an outcome, which hold it differently; the input\'s is "ThingInput"',
    );
  });

  it("reads what OpenAPI 3.0 spells its own way as the schema it means, from YAML", async () => {
    const yaml = `
openapi: 3.0.3
info: { title: Upstream, version: 1.0.0 }
paths:
  /things:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                expiresAt:
                  type: integer
                  minimum: 1776867570
                  exclusiveMinimum: true
                  example: &at 1786867570
                note: { type: string, nullable: true, example: *at }
      responses:
        '204': { description: No Content }
`;

    const { schemas } = await deriving(yaml, {
      createThing: { upstream: "POST /things" },
    });

    expect(schemas.operations.createThing?.input.properties).toEqual({
      payload: {
        type: "object",
        properties: {
          expiresAt: { type: "integer", exclusiveMinimum: 1776867570 },
          note: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
    });
  });

  it("declares what the gateway reports beside a result from the configuration, not the document", async () => {
    const sources: SchemaSources = {
      load: () =>
        Promise.resolve(
          JSON.stringify(
            document({
              "/things": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      // What the document says of the header is not what a caller is offered.
                      headers: {
                        "X-Request-Id": {
                          schema: { type: "string", format: "uuid" },
                        },
                      },
                      content: { "application/json": { schema: THING } },
                    },
                  },
                },
              },
            }),
          ),
        ),
    };
    const config = {
      id: "test",
      driver: openapiRest({
        spec: "openapi.json",
        auth: [],
        metadata: {
          upstreamRequestId: {
            header: "X-Request-Id",
            schema: {
              type: "string",
              maxLength: 128,
              description: "The upstream's id for the request",
            },
          },
        },
      }),
      operations: { getThing: { upstream: "GET /things" } },
    };

    const { schemas } = await derive(config, sources);

    expect(schemas.meta).toEqual({
      upstreamRequestId: {
        type: "string",
        maxLength: 128,
        description: "The upstream's id for the request",
      },
    });
  });

  it("reports everything it cannot derive from together", async () => {
    expect(
      await problemsOf(
        deriving(
          document({
            "/things": {
              get: { responses: { "400": { description: "Bad Request" } } },
            },
          }),
          {
            getThing: { upstream: "GET /things" },
            other: { upstream: "GET /elsewhere" },
            // @ts-expect-error upstream is required, and derivation says so of a configuration the compiler did not check
            unnamed: {},
          },
        ),
      ),
    ).toEqual([
      "GET /things describes no response the driver maps to an outcome (200, 201, 202 or 204)",
      'operation "other" is GET /elsewhere, which the document does not describe',
      'operation "unnamed" names no upstream request',
    ]);
  });

  it("refuses a document whose references lead nowhere, before deriving anything from it", async () => {
    const [problem] = await problemsOf(
      deriving(
        document({
          "/things": {
            get: {
              responses: { "200": { $ref: "#/components/responses/Missing" } },
            },
          },
        }),
        { getThing: { upstream: "GET /things" } },
      ),
    );

    expect(problem).toContain("#/components/responses/Missing");
  });

  it("refuses what is not an OpenAPI document, without repeating what it held", async () => {
    expect(await problemsOf(deriving("{ not: [valid", {}))).toEqual([
      "it is not an OpenAPI document",
    ]);
    await expect(
      deriving({ openapi: "3.0.3", info: { title: "No paths" } }, {}),
    ).rejects.toThrow(OpenApiDeriveError);
  });
});

describe("derive, a body or a field of any shape", () => {
  const SHAPE = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  };
  const taking = (schema: object) =>
    document({
      "/v1/things": {
        post: {
          requestBody: { content: { "application/json": { schema } } },
          responses: ok(THING),
        },
      },
    });
  const posting = (narrow?: JSONSchema): Operations => ({
    postThing: {
      upstream: "POST /v1/things",
      ...(narrow === undefined ? {} : { narrow: { payload: narrow } }),
    },
  });
  const payloadOf = async (derived: ReturnType<typeof deriving>) => {
    const { properties } =
      (await derived).schemas.operations.postThing?.input ?? {};
    return (properties as JSONSchema | undefined)?.payload;
  };

  it("leaves one nothing states the shape of open, as an object of any shape", async () => {
    const { schemas, notes } = await deriving(
      taking({ type: "object" }),
      posting(),
    );

    expect(schemas.operations.postThing?.input.properties).toEqual({
      payload: { type: "object" },
    });
    expect(notes).toContain(
      'POST /v1/things request body names no field, so it is left open as an object of any shape; an operation\'s "narrow" can state the shape it takes',
    );
  });

  it.each([
    ["an object and nothing more", { type: "object" }],
    ["an object with no fields", { type: "object", properties: {} }],
    [
      "an object open to anything",
      { type: "object", additionalProperties: true },
    ],
    ["any value at all", {}],
  ])(
    "takes the shape a narrowing states in place of %s",
    async (_what, schema) => {
      expect(await payloadOf(deriving(taking(schema), posting(SHAPE)))).toEqual(
        SHAPE,
      );
    },
  );

  it("takes it for a field of any shape inside a body the document describes", async () => {
    const payload = await payloadOf(
      deriving(
        taking({
          type: "object",
          properties: { data: { type: "object" }, ttl: { type: "integer" } },
          required: ["data"],
        }),
        posting({ type: "object", properties: { data: SHAPE } }),
      ),
    );

    expect(payload).toEqual({
      type: "object",
      properties: { data: SHAPE, ttl: { type: "integer" } },
      required: ["data"],
      additionalProperties: false,
    });
  });

  it("refuses to add a field to an object the document says holds none", async () => {
    // Written closed, it admits only `{}`: a field stated there is one the upstream refuses.
    expect(
      await problemsOf(
        deriving(
          taking({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          posting(SHAPE),
        ),
      ),
    ).toEqual([
      'operation "postThing" narrowing of the request body.id is narrowed, and the document has no such field there',
    ]);
  });
});

describe("derive, a field named like a keyword", () => {
  it("reads a field called $ref as the field it is", async () => {
    // A reference is a keyword at a schema's own position; under `properties` the same text is
    // a name, and an upstream may well have a field called that.
    const named = {
      type: "object",
      properties: { $ref: { type: "string" } },
      required: ["$ref"],
    };
    const { schemas } = await deriving(
      document({
        "/things": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true },
                },
              },
            },
            responses: ok(THING),
          },
        },
      }),
      { make: { upstream: "POST /things", narrow: { payload: named } } },
    );

    expect(schemas.operations.make?.input).toMatchObject({
      properties: { payload: named },
    });
  });
});

describe("derive, a path whose own parameters could reach another endpoint", () => {
  const ok = {
    "200": {
      description: "OK",
      content: { "application/json": { schema: { type: "object" } } },
    },
  };
  const path = (name: string, schema: object = { type: "string" }) => ({
    in: "path",
    name,
    required: true,
    schema,
  });
  const routes = (service: object, identifier: object) =>
    document({
      "/v1/{service}/{identifier}": {
        get: {
          parameters: [
            path("service", service),
            path("identifier", identifier),
          ],
          responses: ok,
        },
      },
      // Written out, so the upstream routes "/v1/app/admin" here and not to the template.
      "/v1/app/admin": { get: { responses: ok } },
    });
  const operation: Operations = {
    getThing: {
      upstream: "GET /v1/app/{identifier}",
      matches: "/v1/{service}/{identifier}",
      parameters: { identifier: { in: "path" } },
    },
  };

  it("refuses one nothing in the document keeps from reaching it", async () => {
    // A caller sending "admin" would be answered by the other endpoint, and held to schemas
    // derived from this one.
    expect(
      await problemsOf(
        deriving(routes({ type: "string" }, { type: "string" }), operation),
      ),
    ).toEqual([
      'operation "getThing" is /v1/app/{identifier}, served by "/v1/{service}/{identifier}", and a value of its own parameters would reach "/v1/app/admin", which the upstream routes to first; nothing in the document says it cannot',
    ]);
  });

  it("takes one the document's own values keep from reaching it", async () => {
    await expect(
      deriving(
        routes({ type: "string" }, { type: "string", enum: ["one", "two"] }),
        operation,
      ),
    ).resolves.toBeDefined();
  });

  it("reads a value and a route's text as the same thing before believing one excludes it", async () => {
    // A template writes its segments as they go into a URL and a value is what a caller sends:
    // "admin panel" is written "admin%20panel" there, and reading the two as written would take
    // a value that reaches the segment for one that cannot.
    const encoded = document({
      "/v1/{service}/{identifier}": {
        get: {
          parameters: [
            path("service"),
            path("identifier", { type: "string", enum: ["admin panel"] }),
          ],
          responses: ok,
        },
      },
      "/v1/app/admin%20panel": { get: { responses: ok } },
    });

    expect(await problemsOf(deriving(encoded, operation))).toEqual([
      'operation "getThing" is /v1/app/{identifier}, served by "/v1/{service}/{identifier}", and a value of its own parameters would reach "/v1/app/admin%20panel", which the upstream routes to first; nothing in the document says it cannot',
    ]);
  });

  it("reads a route's own text the way a request writes it", async () => {
    // The runtime writes "é" into a URL as "%C3%A9", which is the other route exactly: read as
    // the text each is written with, the two would never be the same and the overlap would go
    // unseen.
    const accented = document({
      "/v1/{id}é": { get: { parameters: [path("id")], responses: ok } },
      "/v1/admin%C3%A9": { get: { responses: ok } },
    });

    expect(
      await problemsOf(
        deriving(accented, {
          getThing: {
            upstream: "GET /v1/{id}é",
            parameters: { id: { in: "path" } },
          },
        }),
      ),
    ).toEqual([
      'operation "getThing" is /v1/{id}é, served by "/v1/{id}é", and a value of its own parameters would reach "/v1/admin%C3%A9", which the upstream routes to first; nothing in the document says it cannot',
    ]);

    const separate = document({
      "/v1/é/{id}": { get: { parameters: [path("id")], responses: ok } },
      "/v1/%C3%A9/admin": { get: { responses: ok } },
    });

    expect(
      await problemsOf(
        deriving(separate, {
          getThing: {
            upstream: "GET /v1/é/{id}",
            parameters: { id: { in: "path" } },
          },
        }),
      ),
    ).toEqual([
      'operation "getThing" is /v1/é/{id}, served by "/v1/é/{id}", and a value of its own parameters would reach "/v1/%C3%A9/admin", which the upstream routes to first; nothing in the document says it cannot',
    ]);
  });

  it("says a path with no parameters of its own reaches another as it is written", async () => {
    // "%61pp" is "app" to the upstream, so no value of anyone's takes this path elsewhere: the
    // path itself is the other route's.
    expect(
      await problemsOf(
        deriving(routes({ type: "string" }, { type: "string" }), {
          getThing: {
            upstream: "GET /v1/%61pp/admin",
            matches: "/v1/{service}/{identifier}",
          },
        }),
      ),
    ).toEqual([
      'operation "getThing" is /v1/%61pp/admin, served by "/v1/{service}/{identifier}", and the upstream would route it to "/v1/app/admin", which is more specific',
    ]);
  });

  it.each([
    ["an integer", { type: "integer" }],
    ["a pattern", { type: "string", pattern: "^[0-9]+$" }],
    ["a format", { type: "string", format: "uuid" }],
  ])(
    "takes one whose schema refuses the other route's text, as %s does",
    async (_what, schema) => {
      // No value a caller could send for "id" is written "me".
      const users = document({
        "/users/{id}": {
          get: { parameters: [path("id", schema)], responses: ok },
        },
        "/users/me": { get: { responses: ok } },
      });

      await expect(
        deriving(users, {
          getUser: {
            upstream: "GET /users/{id}",
            parameters: { id: { in: "path" } },
          },
        }),
      ).resolves.toBeDefined();
    },
  );

  it.each([
    ["any text", "me", { type: "string" }],
    ["a number that is written as the other route", "123", { type: "integer" }],
    [
      "a format the check cannot apply, which proves nothing",
      "me",
      { type: "string", format: "unheard-of" },
    ],
  ])("refuses one whose schema admits %s", async (_what, route, schema) => {
    const users = document({
      "/users/{id}": {
        get: { parameters: [path("id", schema)], responses: ok },
      },
      [`/users/${route}`]: { get: { responses: ok } },
    });

    expect(
      await problemsOf(
        deriving(users, {
          getUser: {
            upstream: "GET /users/{id}",
            parameters: { id: { in: "path" } },
          },
        }),
      ),
    ).toEqual([
      `operation "getUser" is /users/{id}, served by "/users/{id}", and a value of its own parameters would reach "/users/${route}", which the upstream routes to first; nothing in the document says it cannot`,
    ]);
  });

  it("is not taken to reach a route whose text around a parameter it lacks", async () => {
    const files = document({
      "/v1/{rest+}": {
        get: { parameters: [path("rest")], responses: ok },
      },
      "/v1/{file}.json": {
        get: { parameters: [path("file")], responses: ok },
      },
    });

    await expect(
      deriving(files, {
        getNotifications: {
          upstream: "GET /v1/notifications",
          matches: "/v1/{rest+}",
        },
      }),
    ).resolves.toBeDefined();
  });

  it("sees through a parameter that shares its segment with text", async () => {
    // A request substitutes into it, so "{id}.json" reaches "admin.json"; read as text it would
    // be a segment no value could ever produce, and the overlap would go unseen.
    const embedded = document({
      "/v1/{id}.json": {
        get: { parameters: [path("id")], responses: ok },
      },
      "/v1/admin.json": { get: { responses: ok } },
    });

    expect(
      await problemsOf(
        deriving(embedded, {
          getThing: {
            upstream: "GET /v1/{id}.json",
            parameters: { id: { in: "path" } },
          },
        }),
      ),
    ).toEqual([
      'operation "getThing" is /v1/{id}.json, served by "/v1/{id}.json", and a value of its own parameters would reach "/v1/admin.json", which the upstream routes to first; nothing in the document says it cannot',
    ]);
  });
});

describe("derive, the value a path writes into a parameter", () => {
  const ok = {
    "200": {
      description: "OK",
      content: { "application/json": { schema: { type: "object" } } },
    },
  };
  const held = (schema: object, openapi = "3.0.3") => ({
    openapi,
    info: { title: "Upstream", version: "1.0.0" },
    paths: {
      "/things/{id}": {
        get: {
          parameters: [{ in: "path", name: "id", required: true, schema }],
          responses: ok,
        },
      },
    },
    components: { schemas: { Kind: { type: "string", enum: ["one"] } } },
  });
  const filling = (path: `/${string}`, schema: object, openapi?: string) =>
    deriving(held(schema, openapi), {
      getThing: { upstream: `GET ${path}`, matches: "/things/{id}" },
    });

  it("reads it as the type the schema names, and decoded", async () => {
    // "42" is the number a schema of integers lists, and "a%20b" the text a schema of strings
    // does: a segment read as the text it is written as would be refused by both.
    await expect(
      filling("/things/42", { type: "integer", enum: [42] }),
    ).resolves.toBeDefined();
    await expect(
      filling("/things/a%20b", { type: "string", enum: ["a b"] }),
    ).resolves.toBeDefined();
  });

  it("refuses one the schema does not admit, however the schema says so", async () => {
    expect(
      await problemsOf(
        filling("/things/abc", { type: "string", pattern: "^[0-9]+$" }),
      ),
    ).toEqual([
      'GET /things/abc fills path parameter "id" with "abc", which the document does not admit there: must match pattern "^[0-9]+$"',
    ]);

    expect(
      await problemsOf(
        filling("/things/two", { type: "string", const: "one" }, "3.1.0"),
      ),
    ).toEqual([
      'GET /things/two fills path parameter "id" with "two", which the document does not admit there: must be equal to constant',
    ]);

    // Behind a name, which is where a document usually keeps a list of values.
    expect(
      await problemsOf(
        filling("/things/two", { $ref: "#/components/schemas/Kind" }),
      ),
    ).toEqual([
      'GET /things/two fills path parameter "id" with "two", which the document does not admit there: must be equal to one of the allowed values',
    ]);

    expect(
      await problemsOf(filling("/things/abc", { type: "integer" })),
    ).toEqual([
      'GET /things/abc fills path parameter "id" with "abc", which the document does not admit there: must be integer',
    ]);
  });

  it("holds it to everything the schema is written with, however far that reaches", async () => {
    // A bound, a branch of an `allOf`, and a name behind a name: each says what the upstream
    // takes there, and the value never reaches a validator, since the parameter is gone from
    // the input by the time one runs.
    expect(
      await problemsOf(filling("/things/1", { type: "integer", minimum: 10 })),
    ).toEqual([
      'GET /things/1 fills path parameter "id" with "1", which the document does not admit there: must be >= 10',
    ]);
    await expect(
      filling("/things/11", { type: "integer", minimum: 10 }),
    ).resolves.toBeDefined();

    expect(
      await problemsOf(
        filling("/things/bad", {
          allOf: [{ type: "string", enum: ["good"] }],
        }),
      ),
    ).toEqual([
      'GET /things/bad fills path parameter "id" with "bad", which the document does not admit there: must be equal to one of the allowed values',
    ]);
  });

  it("holds it to what a validator would, and to nothing this reads for itself", async () => {
    // What a schema makes of a value is the validators' own answer: a branch that would read the
    // value as something else, and a name with keywords beside it. The rest of what a schema
    // can say, and what each of those means, is held to the same answer where it is worked out.
    for (const [schema, value] of [
      [{ type: "integer", allOf: [{ minimum: 10 }] }, "1"],
      [{ $ref: "#/components/schemas/Kind", enum: ["good"] }, "bad"],
      [{ type: "string", minLength: 2 }, "\u{1F600}"],
    ] as const) {
      expect(
        await problemsOf(filling(`/things/${value}`, schema)),
        JSON.stringify(schema),
      ).toHaveLength(1);
    }

    // And one it admits is admitted, format and all: a fixed identifier is written as one.
    await expect(
      filling("/things/0192e5a0-9d0c-7000-8000-000000000000", {
        type: "string",
        format: "uuid",
      }),
    ).resolves.toBeDefined();
    await expect(
      filling("/things/\u{1F600}", { type: "string", maxLength: 1 }),
    ).resolves.toBeDefined();
  });

  it("refuses text no number could be written as, rather than reading it as one", () => {
    // Four hundred digits are not a number the machine can hold, and what it rounds them to is
    // not what the path says. Read as the text it is, the schema refuses it.
    const digits = "9".repeat(400);
    return expect(
      problemsOf(filling(`/things/${digits}`, { type: "integer" })),
    ).resolves.toEqual([
      `GET /things/${digits} fills path parameter "id" with "${digits}", which the document does not admit there: must be integer`,
    ]);
  });

  it("reads text as a number only where it is how that number is written", async () => {
    // "…993" parses as the number written "…992": read as it, the schema would admit a path
    // that sends something else. "007" and "42.0" are not how 7 and 42 are written either.
    for (const [text, value] of [
      ["9007199254740993", 9007199254740992],
      ["007", 7],
      ["42.0", 42],
    ] as const) {
      expect(
        await problemsOf(
          filling(`/things/${text}`, { type: "integer", enum: [value] }),
        ),
      ).toEqual([
        `GET /things/${text} fills path parameter "id" with "${text}", which the document does not admit there: must be integer; must be equal to one of the allowed values`,
      ]);
    }
    await expect(
      filling("/things/9007199254740992", {
        type: "integer",
        enum: [9007199254740992],
      }),
    ).resolves.toBeDefined();
  });

  it("refuses one the document describes by its content, as it would one a caller sends", async () => {
    // Nothing reads what the content says once the parameter has left the input, so a text the
    // content's schema refuses would otherwise derive as if nothing held it.
    const described = {
      openapi: "3.0.3",
      info: { title: "Upstream", version: "1.0.0" },
      paths: {
        "/things/{id}": {
          get: {
            parameters: [
              {
                in: "path",
                name: "id",
                required: true,
                content: {
                  "application/json": {
                    schema: { type: "integer", minimum: 10 },
                  },
                },
              },
            ],
            responses: ok,
          },
        },
      },
    };

    expect(
      await problemsOf(
        deriving(described, {
          getThing: {
            upstream: "GET /things/not-an-integer",
            matches: "/things/{id}",
          },
        }),
      ),
    ).toEqual([
      'GET /things/not-an-integer describes path parameter "id" by its content rather than a schema, which is not supported',
    ]);
  });

  it("refuses one whose schema would be checked asynchronously, rather than running it", async () => {
    // Such a schema compiles to a validator answering with a promise, which read as an answer
    // is one that passed: the value would derive, and the rejection would come back with
    // nothing waiting for it. Generation refuses the schema too, but a value a path fixes has
    // left the input before any generated validator runs. 3.0 has no `$async` to write.
    const rejections: unknown[] = [];
    const watch = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", watch);
    try {
      expect(
        await problemsOf(
          filling(
            "/things/1",
            { $async: true, type: "integer", minimum: 10 },
            "3.1.0",
          ),
        ),
      ).toEqual([
        'GET /things/1 fills path parameter "id" with "1", which the document does not admit there: "$async" is not supported, because validation is synchronous',
      ]);
      // One with nothing waiting for it is reported a turn later, so there is one to wait.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", watch);
    }
  });

  it("refuses one held to something it cannot hold the value to", () => {
    // A format nothing here implements says the upstream takes less than the rest of the schema
    // does, and a value admitted without it has not been held to what the document wrote.
    return expect(
      problemsOf(filling("/things/abc", { type: "string", format: "weird" })),
    ).resolves.toEqual([
      'GET /things/abc fills path parameter "id" with "abc", which the document does not admit there: unknown format "weird" ignored in schema at path "#"',
    ]);
  });
});
