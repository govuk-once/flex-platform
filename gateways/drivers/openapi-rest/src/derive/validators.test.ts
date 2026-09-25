import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emitValidators } from "@repo/gateway-codegen";
import type {
  GatewaySchemas,
  JSONSchema,
  Validator,
} from "@repo/gateway-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { noAuth, openapiRest } from "../index.ts";
import { type Conversion, convertSchema, type Side } from "./convert.ts";
import derive from "./index.ts";

// What a converted schema does with a value, through the validators a gateway is generated with.
// A conversion moves what a schema admits on purpose, and which way it moved is not visible in
// the shape: a case here names the value that tells the upstream's schema from the converted one
// and says which of the two must take it.
//
// An input the gateway admits and the upstream refuses is a request the gateway vouches for and
// the upstream rejects; an outcome the gateway refuses and the upstream sends is a response that
// reaches a caller as a contract violation. Both are what these hold the conversion to. An
// outcome the gateway admits and the upstream does not describe is the relaxation an outcome is
// converted for, and a case says so rather than being held to the upstream's own verdict.

interface Case {
  readonly name: string;
  readonly side: Side;
  readonly upstream: JSONSchema;
  readonly value: unknown;
  // What the upstream's own schema does with the value, and what the converted one must do. They
  // part only where a conversion narrows an input on purpose: the gateway may refuse what the
  // upstream would have taken, and may never take what the upstream refuses.
  readonly upstreamTakes: boolean;
  readonly gatewayTakes: boolean;
}

const CASES: readonly Case[] = [
  {
    // Closed inside a `not`, the subject matches fewer values, so the `not` matches more and
    // the gateway takes a request the upstream refuses.
    name: "notClosedInput",
    side: "input",
    upstream: {
      type: "object",
      properties: { banned: { type: "string" }, other: { type: "integer" } },
      not: {
        type: "object",
        properties: { banned: { type: "string" } },
        required: ["banned"],
      },
    },
    value: { banned: "x", other: 1 },
    upstreamTakes: false,
    gatewayTakes: false,
  },
  {
    // The bound dropped inside a `not` leaves the subject matching more, so the `not` matches
    // less and a response the upstream sends fails the outcome.
    name: "notLoosenedOutcome",
    side: "output",
    upstream: {
      type: "object",
      properties: { note: { type: "string" } },
      not: {
        type: "object",
        properties: { note: { type: "string", maxLength: 3 } },
        required: ["note"],
      },
    },
    value: { note: "abcde" },
    upstreamTakes: true,
    gatewayTakes: true,
  },
  {
    // Opened, each branch would admit any string, so "a" matches both and a `oneOf` refuses
    // what two of its branches match: a value the upstream sends would fail the outcome.
    // Nothing tells these two apart, so neither is opened.
    name: "untaggedUnionOutcome",
    side: "output",
    upstream: {
      oneOf: [
        { type: "string", enum: ["a", "b"] },
        { type: "string", enum: ["c", "d"] },
      ],
    },
    value: "a",
    upstreamTakes: true,
    gatewayTakes: true,
  },
  {
    // What an outcome is relaxed for: a bound the upstream may loosen is dropped, so a response
    // the document does not describe today is one the gateway goes on taking.
    name: "loosenedOutcome",
    side: "output",
    upstream: {
      type: "object",
      properties: { note: { type: "string", maxLength: 3 } },
    },
    value: { note: "abcde" },
    upstreamTakes: false,
    gatewayTakes: true,
  },
  {
    // A count that starts at none is not a count that starts at one: an array holding no match
    // passes the upstream, and an outcome that dropped the zero would fail it.
    name: "countedFromNoneOutcome",
    side: "output",
    upstream: {
      type: "array",
      contains: { type: "string" },
      minContains: 0,
      maxContains: 1,
    },
    value: [],
    upstreamTakes: true,
    gatewayTakes: true,
  },
  {
    // A tuple's elements are schemas in their own right, not another way of saying what the
    // whole is: an ordinary object among them is closed like any other input object.
    name: "tupleObjectInput",
    side: "input",
    upstream: {
      type: "array",
      prefixItems: [{ type: "object", properties: { a: { type: "string" } } }],
    },
    value: [{ a: "x", undeclared: 1 }],
    upstreamTakes: true,
    gatewayTakes: false,
  },
  {
    // `nullable: false` says the schema admits no null, whichever side of the type it is
    // written on.
    name: "notNullableInput",
    side: "input",
    upstream: JSON.parse('{"type":"string","nullable":false}') as JSONSchema,
    value: null,
    upstreamTakes: false,
    gatewayTakes: false,
  },
  {
    // And `nullable: true` says it does.
    name: "nullableInput",
    side: "input",
    upstream: JSON.parse('{"nullable":true,"type":"string"}') as JSONSchema,
    value: null,
    upstreamTakes: true,
    gatewayTakes: true,
  },
];

const conversion = (side: Side): Conversion => ({
  side,
  notes: new Set(),
  problems: [],
  refs: new Map(),
});

// Every case as one gateway, so the validators are generated once rather than once each. A case
// takes the side it is about; the other side of its operation says nothing.
function versionOf(which: "upstream" | "converted"): GatewaySchemas {
  const operations: GatewaySchemas["operations"] = {};
  for (const held of CASES) {
    const schema =
      which === "upstream"
        ? held.upstream
        : (convertSchema(
            held.upstream,
            held.name,
            conversion(held.side),
          ) as JSONSchema);
    // Held as an outcome either way: what is being asked is what the schema admits, and an
    // operation's input has a shape of its own that would stand between the two.
    operations[held.name] = {
      input: { type: "object" },
      outcomes: { ok: schema },
    };
  }
  return { operations };
}

interface Emitted {
  readonly validators: Readonly<
    Record<string, { readonly outcomes: { readonly ok: Validator } }>
  >;
}

const dirs: string[] = [];

async function emit(which: "upstream" | "converted"): Promise<Emitted> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "derive-")));
  dirs.push(dir);
  await emitValidators(versionOf(which), dir);
  return (await import(
    pathToFileURL(path.join(dir, "index.js")).href
  )) as Emitted;
}

let emitted: Readonly<Record<"upstream" | "converted", Emitted>>;

beforeAll(async () => {
  emitted = {
    upstream: await emit("upstream"),
    converted: await emit("converted"),
  };
}, 60_000);

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("what the validators make of a converted schema", () => {
  it.each(CASES.map((held) => [held.name, held] as const))(
    "%s",
    (_name, held) => {
      const takes = (which: "upstream" | "converted"): boolean =>
        emitted[which].validators[held.name]?.outcomes.ok(held.value) === true;

      // What the upstream does with the value is stated, and checked: a case that stopped
      // telling the two schemas apart would otherwise go on passing while testing nothing.
      expect(takes("upstream"), "the upstream's own schema").toBe(
        held.upstreamTakes,
      );
      expect(
        takes("converted"),
        held.gatewayTakes
          ? "the gateway has to take this"
          : "the gateway must not take this",
      ).toBe(held.gatewayTakes);
      // The one direction that is never right for an input, whatever a case intends: the
      // gateway vouches for what it sends, so it may refuse what the upstream would have taken
      // and may never take what the upstream refuses. An outcome runs the other way — it is
      // relaxed on purpose, so it takes responses the document does not describe — and nothing
      // is asserted of it beyond what the case states.
      if (held.side === "input" && !held.upstreamTakes) {
        expect(held.gatewayTakes).toBe(false);
      }
    },
  );
});

// The same schema written out and written as a name. A definition is converted once and stands
// for every place it is named, so one first met on its own must not stay as it was converted
// there: an input's, closed, would refuse the fields its siblings in a composition declare, and
// an outcome's, opened, would leave a union's branches matching the same value.

const BASE = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};
const EXTRA = { type: "object", properties: { extra: { type: "string" } } };
const CARD = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["card"] },
    status: { type: "string", enum: ["a", "b"] },
  },
  required: ["kind"],
};
const CASH = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["cash"] },
    status: { type: "string", enum: ["b", "c"] },
  },
  required: ["kind"],
};

const named = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const DOCUMENT = {
  openapi: "3.0.3",
  info: { title: "Upstream", version: "1.0.0" },
  paths: {
    "/inline": {
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { allOf: [BASE, EXTRA] } },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { oneOf: [CARD, CASH] } },
            },
          },
        },
      },
    },
    "/referenced": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { allOf: [named("Base"), named("Extra")] },
            },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { oneOf: [named("Card"), named("Cash")] },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: { Base: BASE, Extra: EXTRA, Card: CARD, Cash: CASH },
  },
};

interface Pair {
  readonly input: Validator;
  readonly outcomes: { readonly ok: Validator };
}

describe("a schema written out and the same schema named", () => {
  let both: Readonly<Record<string, Pair>>;

  beforeAll(async () => {
    const { schemas } = await derive(
      {
        id: "test",
        driver: openapiRest({ spec: "openapi.json", auth: noAuth() }),
        operations: {
          inline: { upstream: "POST /inline" },
          referenced: { upstream: "POST /referenced" },
        },
      },
      {
        load: (location) =>
          location === "openapi.json"
            ? Promise.resolve(JSON.stringify(DOCUMENT))
            : Promise.reject(new Error(`unexpected ${location}`)),
      },
    );
    const dir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "derive-named-")),
    );
    dirs.push(dir);
    await emitValidators(schemas, dir);
    ({ validators: both } = (await import(
      pathToFileURL(path.join(dir, "index.js")).href
    )) as { validators: Readonly<Record<string, Pair>> });
  }, 60_000);

  it.each([
    // Every field the composition's parts declare, which a part closed on its own would refuse.
    [
      "the fields a composition declares between its parts",
      "input",
      { payload: { id: "i", extra: "e" } },
      true,
    ],
    // A composition is left open on either side, since closing one part would refuse what the
    // others declare; named or written out, it is left open the same way.
    [
      "a field none of them declares",
      "input",
      { payload: { id: "i", other: 1 } },
      true,
    ],
    // The branches are told apart by `kind`, and `status` overlaps: opened, "b" would match
    // both and a `oneOf` refuses what two of its branches match.
    [
      "a value that both branches list",
      "output",
      { kind: "card", status: "b" },
      true,
    ],
    ["a value one branch lists", "output", { kind: "cash", status: "c" }, true],
  ] as const)(
    "takes %s the same way either way",
    (_what, side, value, expected) => {
      for (const name of ["inline", "referenced"]) {
        const held = both[name];
        const takes =
          side === "input"
            ? held?.input(value) === true
            : held?.outcomes.ok(value) === true;
        expect(takes, `${name}: ${JSON.stringify(value)}`).toBe(expected);
      }
    },
  );
});
