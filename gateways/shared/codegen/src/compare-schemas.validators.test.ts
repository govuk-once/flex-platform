import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  GatewaySchemas,
  JSONSchema,
  Validator,
} from "@repo/gateway-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareSchemas } from "./compare-schemas.ts";
import { emitValidators } from "./emit-validators.ts";

// What the comparator says a change does, against what the validators generated from the two
// versions do with a value. The rules are read from the keywords one by one, so each is only
// worth what the emitted code makes of them: a case here names the value that tells the two
// versions apart, and the comparator has to call the break on the side that value is lost from.
//
// A value admitted before and not after means the schema admits less, which an input may not do.
// One admitted after and not before means it admits more, which an outcome may not do. Nothing
// states which side is broken: it is read from the two verdicts, so a case cannot agree with the
// comparator by being written to.

interface Case {
  readonly name: string;
  readonly previous: JSONSchema;
  readonly next: JSONSchema;
  // A definition the two versions both name, changed between them.
  readonly defs?: {
    readonly previous: Record<string, JSONSchema>;
    readonly next: Record<string, JSONSchema>;
  };
  readonly value: unknown;
}

const CASES: readonly Case[] = [
  {
    // "abcde" matched the second branch alone; widening the first leaves both matching, and a
    // value exactly one branch had to admit is admitted by neither count.
    name: "oneOfBranchWidened",
    previous: {
      oneOf: [
        { type: "string", maxLength: 1 },
        { type: "string", minLength: 3 },
      ],
    },
    next: {
      oneOf: [
        { type: "string", maxLength: 5 },
        { type: "string", minLength: 3 },
      ],
    },
    value: "abcde",
  },
  {
    // A branch added to a `oneOf` overlapping one already there takes values away rather than
    // adding them, which is the opposite of what the same branch added to an `anyOf` would do.
    name: "oneOfBranchAdded",
    previous: { oneOf: [{ type: "string" }, { type: "number" }] },
    next: { oneOf: [{ type: "string" }, { type: "number" }, { const: "a" }] },
    value: "a",
  },
  {
    // The definition came to admit more, which under a negation admits less.
    name: "definitionUnderNegation",
    previous: { type: "object", not: { $ref: "BannedShape" } },
    next: { type: "object", not: { $ref: "BannedShape" } },
    defs: {
      previous: {
        BannedShape: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      },
      next: {
        BannedShape: { type: "object", properties: { a: { type: "string" } } },
      },
    },
    value: {},
  },
  {
    // A definition used on both sides of the call: widening it is what an input may do and an
    // outcome may not, so reading it as the one must not stand in for reading it as the other.
    name: "definitionUsedBothWays",
    previous: { $ref: "BoundedText" },
    next: { $ref: "BoundedText" },
    defs: {
      previous: { BoundedText: { type: "string", maxLength: 5 } },
      next: { BoundedText: { type: "string", maxLength: 9 } },
    },
    value: "abcdefghi",
  },
  {
    // The dictionary held every name to a string. Declaring one as a number takes that back.
    name: "dictionaryValueRedeclared",
    previous: { type: "object", additionalProperties: { type: "string" } },
    next: {
      type: "object",
      additionalProperties: { type: "string" },
      properties: { code: { type: "number" } },
    },
    value: { code: 7 },
  },
  {
    // `dependentRequired` lists property names, and one of them is named like an annotation.
    name: "dependentRequiredNamedLikeAnAnnotation",
    previous: {
      type: "object",
      properties: { a: { type: "string" }, description: { type: "string" } },
      dependentRequired: {},
    },
    next: {
      type: "object",
      properties: { a: { type: "string" }, description: { type: "string" } },
      dependentRequired: { description: ["a"] },
    },
    value: { description: "x" },
  },
  {
    // `const` and `enum` each restrict, so together they admit only what they agree on.
    name: "constAndEnumTogether",
    previous: { const: "a" },
    next: { const: "a", enum: ["b"] },
    value: "a",
  },
  {
    // The branches are written the same in both versions; what one of them names is not. "b"
    // matched the constant alone and matches the definition as well now, so the union refuses it.
    name: "oneOfThroughAReference",
    previous: { oneOf: [{ $ref: "Choice" }, { const: "b" }] },
    next: { oneOf: [{ $ref: "Choice" }, { const: "b" }] },
    defs: {
      previous: { Choice: { enum: ["a"] } },
      next: { Choice: { enum: ["a", "b"] } },
    },
    value: "b",
  },
  {
    // A pattern may be spelt like an annotation, and is a pattern all the same.
    name: "patternNamedLikeAnAnnotation",
    previous: {
      type: "object",
      patternProperties: { description: { type: "string" } },
    },
    next: {
      type: "object",
      patternProperties: { description: { type: "number" } },
    },
    value: { description: "a" },
  },
  {
    // So may the name a dependent schema is keyed by.
    name: "dependentSchemaNamedLikeAnAnnotation",
    previous: {
      type: "object",
      properties: { description: { type: "string" } },
      dependentSchemas: {},
    },
    next: {
      type: "object",
      properties: { description: { type: "string" } },
      dependentSchemas: {
        description: { type: "object", properties: { a: { type: "number" } } },
      },
    },
    value: { description: "x", a: "s" },
  },
  {
    // Without `minContains`, an array has to hold a match: removing a zero is a bound arriving.
    // A validator refuses `minContains: 0` with no `maxContains` beside it, so both carry one.
    name: "minContainsRemoved",
    previous: {
      type: "array",
      contains: { type: "string" },
      minContains: 0,
      maxContains: 3,
    },
    next: { type: "array", contains: { type: "string" }, maxContains: 3 },
    value: [],
  },
];

type Side = "previous" | "next";

// Every case as one gateway, so the whole table is generated twice rather than once each.
function versionOf(side: Side): GatewaySchemas {
  const defs: Record<string, JSONSchema> = {};
  const operations: GatewaySchemas["operations"] = {};
  for (const held of CASES) {
    Object.assign(defs, held.defs?.[side] ?? {});
    const schema = held[side];
    operations[held.name] = { input: schema, outcomes: { ok: schema } };
  }
  return { defs, operations };
}

// One case on one side of the call, which is what the comparator is asked about: a break has to
// be reported for the side the value is lost from, and a case is read on its own so that a break
// reported for another cannot stand in for it.
const alone = (
  held: Case,
  side: Side,
  facing: "input" | "outcome",
): GatewaySchemas => ({
  ...(held.defs === undefined ? {} : { defs: held.defs[side] }),
  operations: {
    [held.name]:
      facing === "input"
        ? { input: held[side], outcomes: { ok: { type: "null" } } }
        : { input: { type: "object" }, outcomes: { ok: held[side] } },
  },
});

const breaksFacing = (
  held: Case,
  facing: "input" | "outcome",
): readonly string[] =>
  compareSchemas(alone(held, "previous", facing), alone(held, "next", facing))
    .breaking;

interface Emitted {
  readonly validators: Readonly<Record<string, { readonly input: Validator }>>;
}

const dirs: string[] = [];

async function emit(side: Side): Promise<Emitted> {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "compare-schemas-")),
  );
  dirs.push(dir);
  await emitValidators(versionOf(side), dir);
  return (await import(
    pathToFileURL(path.join(dir, "index.js")).href
  )) as Emitted;
}

let emitted: Readonly<Record<Side, Emitted>>;

beforeAll(async () => {
  emitted = { previous: await emit("previous"), next: await emit("next") };
}, 60_000);

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("what the generated validators make of a change", () => {
  it.each(CASES.map((held) => [held.name, held] as const))(
    "%s",
    (_name, held) => {
      const admitted = (side: Side): boolean =>
        emitted[side].validators[held.name]?.input(held.value) === true;

      const before = admitted("previous");
      const after = admitted("next");
      // A case that says nothing is a case that stopped testing anything.
      expect(before).not.toBe(after);

      // A value lost is a schema admitting less, which an input may not do; one gained is a
      // schema admitting more, which an outcome may not do.
      const facing = before && !after ? "input" : "outcome";

      expect(
        breaksFacing(held, facing),
        `the value is ${before ? "lost" : "gained"}, so the ${facing} is broken`,
      ).not.toEqual([]);
    },
  );
});
