import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CONVERTED_PROBLEM,
  NOT_STRICT_PROBLEM,
  OPTIONAL_PATH_PROBLEM,
  parameterTypes,
  strictInputProblems,
  UNREADABLE_PROBLEMS,
} from "./input-rules.ts";

enum Size {
  Small = 1,
  Large = 2,
}

const Todo = z.strictObject({ id: z.string(), title: z.string() });

const Node = z.strictObject({
  name: z.string(),
  get children() {
    return z.array(Node);
  },
});

// A new object each time, since an object met again is not read twice.
const open = () => z.object({ id: z.string() });

// One field's result, read from the object `parameterTypes` takes.
function typeOf(schema: unknown, location: "path" | "query") {
  return parameterTypes(z.object({ field: schema as z.ZodType }), location);
}

function typeIs(scalar: string, isArray = false) {
  return { ok: true, types: new Map([["field", { scalar, isArray }]]) };
}

function problemIs(problem: string) {
  return { ok: false, problems: [`field: ${problem}`] };
}

describe("strictInputProblems", () => {
  it.each([
    ["a strict object", Todo],
    ["a picked object", Todo.pick({ title: true })],
    ["an extended object", Todo.extend({ done: z.boolean() })],
    ["a transform after checking", Todo.transform(({ id }) => id)],
    ["an object with no fields", z.object({})],
    ["a record", z.record(z.string(), z.string())],
    ["each side of an intersection", z.intersection(open(), open())],
    ["a recursive schema", Node],
  ])("takes %s", (_case, schema) => {
    expect(strictInputProblems(schema, "body")).toEqual([]);
  });

  it.each([
    ["z.object", z.object({ id: z.string() })],
    ["z.looseObject", z.looseObject({ id: z.string() })],
    ["a catchall", z.object({ id: z.string() }).catchall(z.string())],
  ])("refuses %s", (_case, schema) => {
    expect(strictInputProblems(schema, "body")).toEqual([
      `body: ${NOT_STRICT_PROBLEM}`,
    ]);
  });

  it("finds each open object by its location", () => {
    const body = z.strictObject({
      owner: open().optional(),
      tags: z.array(open()).nullable(),
      labels: z.record(z.string(), open()),
      pair: z.tuple([open()], open()),
      either: z.union([z.null(), open()]),
      parsed: open().transform(({ id }) => id),
      later: z.lazy(open).default({ id: "1" }),
      both: z.intersection(z.strictObject({ inner: open() }), open()),
      mixed: z.intersection(open(), z.record(z.string(), open())),
    });

    expect(strictInputProblems(body, "body")).toEqual(
      [
        "owner",
        "tags[]",
        "labels[*]",
        "pair[0]",
        "pair[]",
        "either",
        "parsed",
        "later",
        "both.inner",
        "mixed[*]",
      ].map((at) => `body.${at}: ${NOT_STRICT_PROBLEM}`),
    );
  });

  it("finds each schema that converts its input by its location", () => {
    const body = z.strictObject({
      priority: z.coerce.number(),
      due: z.coerce.date().optional(),
      flags: z.array(z.coerce.boolean()),
      urgent: z.stringbool(),
      prepared: z.preprocess((value) => value, z.string()),
      both: z.intersection(
        z.strictObject({ count: z.coerce.number() }),
        z.strictObject({}),
      ),
      title: z.string(),
    });

    expect(strictInputProblems(body, "body")).toEqual(
      ["priority", "due", "flags[]", "urgent", "prepared", "both.count"].map(
        (at) => `body.${at}: ${CONVERTED_PROBLEM}`,
      ),
    );
  });
});

describe("parameterTypes", () => {
  it.each([
    ["a string", z.string(), "string"],
    ["a string format", z.uuid(), "string"],
    ["a number", z.number().min(1), "number"],
    ["an integer", z.int(), "number"],
    ["a boolean", z.boolean(), "boolean"],
    ["a string enum", z.enum(["open", "done"]), "string"],
    ["a numeric enum", z.enum(Size), "number"],
    ["a literal", z.literal(true), "boolean"],
  ])("reads %s as a %s", (_case, schema, scalar) => {
    expect(typeOf(schema, "path")).toEqual(typeIs(scalar));
    expect(typeOf(schema, "query")).toEqual(typeIs(scalar));
  });

  it("reads an optional query array as repeated, and a default as its type", () => {
    expect(typeOf(z.array(z.number()).optional(), "query")).toEqual(
      typeIs("number", true),
    );
    expect(typeOf(z.string().default("all"), "query")).toEqual(
      typeIs("string"),
    );
  });

  it.each([
    ["z.coerce.number", z.coerce.number()],
    ["z.coerce.boolean", z.coerce.boolean()],
    ["z.coerce.string", z.coerce.string()],
    ["z.stringbool", z.stringbool()],
    ["z.preprocess", z.preprocess((value) => value, z.string())],
  ])("refuses %s", (_case, schema) => {
    const problem = problemIs(CONVERTED_PROBLEM);

    expect(typeOf(schema, "path")).toEqual(problem);
    expect(typeOf(schema, "query")).toEqual(problem);
    expect(typeOf(z.array(schema), "query")).toEqual(problem);
  });

  it.each([
    ["an object", z.strictObject({ id: z.string() })],
    ["a union", z.union([z.string(), z.number()])],
    ["a nullable", z.string().nullable()],
    ["a date", z.date()],
    ["a transform", z.string().transform(Number)],
    ["a literal of mixed types", z.literal(["a", 1])],
    ["a literal text cannot hold", z.literal(1n)],
    ["an array of arrays", z.array(z.array(z.string()))],
    ["an array of optional values", z.array(z.string().optional())],
    ["a value that is not a schema", "string"],
  ])("refuses %s in a query", (_case, schema) => {
    expect(typeOf(schema, "query")).toEqual(
      problemIs(UNREADABLE_PROBLEMS.query),
    );
  });

  it("refuses an array in a path", () => {
    expect(typeOf(z.array(z.string()), "path")).toEqual(
      problemIs(UNREADABLE_PROBLEMS.path),
    );
  });

  it.each([z.string().optional(), z.number().default(1)])(
    "refuses an optional path parameter",
    (schema) => {
      expect(typeOf(schema, "path")).toEqual(problemIs(OPTIONAL_PATH_PROBLEM));
    },
  );

  it("reports each field it cannot read", () => {
    const query = z.strictObject({
      page: z.coerce.number(),
      at: z.date(),
      q: z.string(),
    });

    expect(parameterTypes(query, "query")).toEqual({
      ok: false,
      problems: [
        `page: ${CONVERTED_PROBLEM}`,
        `at: ${UNREADABLE_PROBLEMS.query}`,
      ],
    });
  });
});
