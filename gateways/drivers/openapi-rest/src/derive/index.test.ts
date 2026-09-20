import type {
  DerivedSchemas,
  OperationConfig,
  SchemaSources,
} from "@repo/gateway-config";
import { describe, expect, it } from "vitest";

import type { OpenApiRestDriver, ParameterMapping } from "../index.ts";
import { noAuth, openapiRest } from "../index.ts";
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
    driver: openapiRest({ spec: "openapi.json", auth: noAuth() }),
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
