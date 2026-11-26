import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import type { DescribedSchema } from "./schemas.ts";
import { describeSchema, nameComponents } from "./schemas.ts";
import type { SchemaUse } from "./types.ts";

const AT = "body";

const Tag = z.object({ name: z.string() }).meta({ id: "Tag" });

// A default makes a field optional to send and always there once read.
const Draft = z
  .strictObject({ title: z.string(), done: z.boolean().default(false) })
  .meta({ id: "Draft" });

const Tree: z.ZodType = z
  .strictObject({
    name: z.string(),
    get children() {
      return z.array(Tree);
    },
  })
  .meta({ id: "Tree" });

const Node: z.ZodType = z.strictObject({
  get next() {
    return Node.optional();
  },
});

function described(
  schema: z.ZodType,
  use: SchemaUse = "output",
  at = AT,
): DescribedSchema {
  const result = describeSchema(schema, { use, at });

  assert.isTrue(result.ok, "the schema has a problem");

  return result.described;
}

describe("describeSchema", () => {
  it.each<[SchemaUse, object]>([
    ["input", {}],
    ["output", { required: ["done"], additionalProperties: false }],
  ])("describes the schema as its %s", (use, more) => {
    expect(
      described(z.object({ done: z.boolean().default(false) }), use).schema,
    ).toEqual({
      type: "object",
      properties: { done: { type: "boolean", default: false } },
      ...more,
    });
  });

  it("keeps a named schema apart, under its id", () => {
    expect(described(z.object({ tag: Tag }))).toMatchObject({
      schema: { properties: { tag: { $ref: "#/$defs/Tag" } } },
      defs: { Tag: { properties: { name: { type: "string" } } } },
    });
  });

  it.each([
    [
      "a type JSON does not carry",
      z.object({ due: z.date() }),
      "not describable as JSON Schema, use only what JSON carries, and no transform on a response",
    ],
    [
      "an unnamed recursive schema",
      Node,
      "unnamed recursive schema, name it with .meta({ id })",
    ],
    [
      "an unnamed recursive field",
      z.strictObject({ node: Node }),
      "unnamed recursive schema, name it with .meta({ id })",
    ],
  ])("refuses %s", (_case, schema, problem) => {
    expect(describeSchema(schema, { use: "output", at: AT })).toEqual({
      ok: false,
      problem: `${AT}: ${problem}`,
    });
  });
});

describe("nameComponents", () => {
  function components(schemas: readonly DescribedSchema[]) {
    const result = nameComponents(schemas);

    assert.isTrue(result.ok, "the schemas have problems");

    return result;
  }

  it("makes a named schema one component, which every use refers to", () => {
    const list = described(z.object({ tags: z.array(Tag), first: Tag }));

    const { schemas, resolve } = components([list]);

    expect(schemas).toEqual({
      Tag: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    });
    expect(resolve(list)).toMatchObject({
      properties: {
        tags: { items: { $ref: "#/components/schemas/Tag" } },
        first: { $ref: "#/components/schemas/Tag" },
      },
    });
  });

  it("makes a named schema two components when its input and output differ", () => {
    const output = described(Draft, "output");
    const input = described(z.strictObject({ draft: Draft }), "input");

    const { schemas, resolve } = components([output, input]);

    expect(schemas).toMatchObject({
      Draft: { required: ["title", "done"] },
      DraftInput: { required: ["title"] },
    });
    expect(resolve(output)).toEqual({ $ref: "#/components/schemas/Draft" });
    expect(resolve(input)).toMatchObject({
      properties: { draft: { $ref: "#/components/schemas/DraftInput" } },
    });
  });

  it.each([
    ["output first", ["output", "input"]],
    ["input first", ["input", "output"]],
  ] as const)(
    "splits each named schema that holds one that splits, however deep, %s",
    (_case, uses) => {
      // Only Draft's own JSON differs between input and output.
      const List = z.strictObject({ first: Draft }).meta({ id: "List" });

      const Page = z.strictObject({ list: List }).meta({ id: "Page" });

      const { schemas } = components(uses.map((use) => described(Page, use)));

      expect(schemas).toMatchObject({
        Page: { properties: { list: { $ref: "#/components/schemas/List" } } },
        PageInput: {
          properties: { list: { $ref: "#/components/schemas/ListInput" } },
        },
        List: { properties: { first: { $ref: "#/components/schemas/Draft" } } },
        ListInput: {
          properties: { first: { $ref: "#/components/schemas/DraftInput" } },
        },
      });
    },
  );

  it("makes a named recursive schema a component that refers to itself", () => {
    expect(components([described(Tree, "input")]).schemas).toEqual({
      Tree: {
        type: "object",
        properties: {
          name: { type: "string" },
          children: {
            type: "array",
            items: { $ref: "#/components/schemas/Tree" },
          },
        },
        required: ["name", "children"],
        additionalProperties: false,
      },
    });
  });

  it.each<[string, () => readonly DescribedSchema[], string]>([
    [
      "an id used for two different schemas",
      () => [
        described(Tag, "output", "first"),
        described(
          z.object({ label: z.string() }).meta({ id: "Tag" }),
          "output",
          "second",
        ),
      ],
      'second: duplicate id "Tag", also used by first, give each schema its own id',
    ],
    [
      "an id the document reserves",
      () => [
        described(z.object({ code: z.string() }).meta({ id: "Reserved" })),
      ],
      `${AT}: component name "Reserved" already used by the document, choose another id`,
    ],
    [
      "an input's name another id has",
      () => [
        described(
          z.object({ title: z.string() }).meta({ id: "DraftInput" }),
          "output",
          "first",
        ),
        described(Draft, "output", "second"),
        described(Draft, "input", "third"),
      ],
      'third: component name "DraftInput" already used by first, choose another id',
    ],
    [
      "an id that is not a component's name",
      () => [described(z.object({ code: z.string() }).meta({ id: "a tag" }))],
      `${AT}: invalid id "a tag", must be letters, digits, ".", "_" and "-"`,
    ],
  ])("refuses %s", (_case, schemas, problem) => {
    expect(
      nameComponents(schemas(), new Map([["Reserved", "the document"]])),
    ).toEqual({ ok: false, problems: [problem] });
  });
});
