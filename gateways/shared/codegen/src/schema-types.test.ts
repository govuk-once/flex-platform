import type { JSONSchema } from "@repo/gateway-types";
import { describe, expect, it } from "vitest";

import { type TypeContext, typeExpression } from "./schema-types.ts";

const USER_RECORD: JSONSchema = {
  type: "object",
  properties: { id: { type: "string" }, note: { type: "string" } },
  required: ["id"],
};

const ctx: TypeContext = {
  defs: new Map([["UserRecord", "UserRecord"]]),
  schemas: new Map([["UserRecord", USER_RECORD]]),
};

const type = (schema: unknown) => typeExpression(schema, ctx);

describe("typeExpression", () => {
  it("names the scalar types", () => {
    expect(type({ type: "string" })).toBe("string");
    expect(type({ type: "number" })).toBe("number");
    expect(type({ type: "integer" })).toBe("number");
    expect(type({ type: "boolean" })).toBe("boolean");
    expect(type({ type: "null" })).toBe("null");
  });

  it("marks properties the schema does not require as optional", () => {
    expect(
      type({
        type: "object",
        properties: { id: { type: "string" }, note: { type: "string" } },
        required: ["id"],
      }),
    ).toBe(
      "{ readonly id: string; readonly note?: string; readonly [key: string]: unknown; }",
    );
  });

  it("quotes a property name that is not an identifier", () => {
    expect(
      type({ type: "object", properties: { "x-trace": { type: "string" } } }),
    ).toBe('{ readonly "x-trace"?: string; readonly [key: string]: unknown; }');
  });

  it("describes an object with no properties by what it admits", () => {
    // Leaving `additionalProperties` out admits every name, which is what writing `true` says;
    // the two are one schema and read as one type.
    expect(type({ type: "object" })).toBe("Record<string, unknown>");
    expect(type({ type: "object", additionalProperties: true })).toBe(
      "Record<string, unknown>",
    );
    expect(type({ type: "object", additionalProperties: false })).toBe(
      "Record<string, never>",
    );
  });

  it("admits the names a schema does not close", () => {
    // A declared field and nothing said about the rest: the caller may send more, so the type
    // has to take more. Refusing them here would refuse a request the gateway accepts.
    const open = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };

    expect(type(open)).toBe(
      "{ readonly id: string; readonly [key: string]: unknown; }",
    );
    expect(type({ ...open, additionalProperties: true })).toBe(type(open));
    expect(type({ ...open, additionalProperties: false })).toBe(
      "{ readonly id: string; }",
    );
  });

  it("carries additional properties into an index signature", () => {
    expect(
      type({ type: "object", additionalProperties: { type: "string" } }),
    ).toBe("{ readonly [key: string]: string | undefined; }");
  });

  it("admits the declared properties in the index signature as well", () => {
    // TypeScript makes an index signature govern every declared property; JSON Schema applies
    // `additionalProperties` only to the fields `properties` does not name, so a declaration
    // that named only the additional type would not compile.
    expect(
      type({
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: { type: "string" },
      }),
    ).toBe(
      "{ readonly id: number; readonly [key: string]: string | number | undefined; }",
    );
  });

  it("keeps a schema's own shape beside its combinators", () => {
    // A combinator constrains what sits beside it; dropping the siblings would lose fields the
    // caller must send. The object keywords of both become one declaration.
    expect(
      type({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        allOf: [
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        ],
      }),
    ).toBe(
      "{ readonly id: string; readonly name: string; readonly [key: string]: unknown; }",
    );

    // The enclosing type narrows each branch: null was never admissible here, so the branch
    // that asks for it admits nothing and leaves the union.
    expect(
      type({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        anyOf: [{ type: "object" }, { type: "null" }],
      }),
    ).toBe("{ readonly id: string; readonly [key: string]: unknown; }");
  });

  it("reads each union branch against everything enclosing it", () => {
    // What the composition requires holds inside a branch that declares the field.
    expect(
      type({
        type: "object",
        required: ["id"],
        anyOf: [
          { properties: { id: { type: "string" } } },
          { properties: { id: { type: "number" } } },
        ],
      }),
    ).toBe(
      "{ readonly id: string; readonly [key: string]: unknown; } | { readonly id: number; readonly [key: string]: unknown; }",
    );

    // A branch of object keywords says nothing about null, which the schema still admits.
    expect(
      type({
        type: ["object", "null"],
        anyOf: [
          { properties: { tenant: { type: "string" } }, required: ["tenant"] },
        ],
      }),
    ).toBe(
      "{ readonly tenant: string; readonly [key: string]: unknown; } | null",
    );

    // A branch that names its own type keeps it, and what it declares with it.
    expect(
      type({
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        ],
      }),
    ).toBe(
      "string | { readonly id: string; readonly [key: string]: unknown; }",
    );

    expect(
      type({
        anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      }),
    ).toBe("readonly string[] | null");
  });

  it("counts an integer as a number rather than something else", () => {
    // Every integer is a number, so narrowing one by the other leaves the integers, not nothing.
    expect(type({ type: "number", anyOf: [{ type: "integer" }] })).toBe(
      "number",
    );
    expect(type({ type: "integer", anyOf: [{ type: "number" }] })).toBe(
      "number",
    );
    // Types that really are disjoint still admit nothing.
    expect(type({ type: "string", anyOf: [{ type: "number" }] })).toBe("never");
  });

  it("writes one union rather than a union of unions", () => {
    expect(
      type({
        type: ["object", "null"],
        anyOf: [
          { properties: { a: { type: "string" } }, required: ["a"] },
          { properties: { b: { type: "string" } }, required: ["b"] },
        ],
      }),
    ).toBe(
      "{ readonly a: string; readonly [key: string]: unknown; } | null | { readonly b: string; readonly [key: string]: unknown; }",
    );
  });

  it("widens rather than narrows when a composition has too many ways through", () => {
    // Above the budget the branches are dropped, not intersected: the contract must not reject
    // a request the gateway accepts. Six nested pairs inside one branch is 64 ways through.
    const pair = (name: string) => ({
      anyOf: [
        { properties: { [`${name}a`]: { type: "string" } } },
        { properties: { [`${name}b`]: { type: "string" } } },
      ],
    });

    expect(
      type({
        type: ["object", "null"],
        anyOf: [
          {
            allOf: ["1", "2", "3", "4", "5", "6"].map((name) => pair(name)),
          },
        ],
      }),
    ).toBe("Record<string, unknown> | null");
  });

  it("requires a field a union branch takes from a shared definition", () => {
    expect(
      type({
        type: "object",
        required: ["note"],
        oneOf: [
          { $ref: "UserRecord" },
          { properties: { note: { type: "number" } } },
        ],
      }),
    ).toBe(
      "(UserRecord & { readonly note: string; readonly [key: string]: unknown; }) | { readonly note: number; readonly [key: string]: unknown; }",
    );
  });

  it("requires a field the composition requires, wherever it is declared", () => {
    // `required` and `properties` can sit in different parts of one composition; a field the
    // schema requires must not reach the caller as optional.
    expect(
      type({
        type: "object",
        required: ["id"],
        allOf: [{ type: "object", properties: { id: { type: "string" } } }],
      }),
    ).toBe("{ readonly id: string; readonly [key: string]: unknown; }");
  });

  it("requires a field only a shared definition declares", () => {
    // The reference keeps its name, so the field is named again, required: a property is
    // required when any member of an intersection requires it.
    expect(
      type({
        type: "object",
        required: ["note"],
        allOf: [{ $ref: "UserRecord" }],
      }),
    ).toBe(
      "UserRecord & { readonly note: string; readonly [key: string]: unknown; }",
    );
  });

  it("requires a field a chain of definitions declares", () => {
    // The chain is read to its end, however long it is: the field is declared where the chain
    // stops, and the composition that requires it says so.
    const links = Array.from({ length: 24 }, (_, index) => index);
    const schemas = new Map<string, JSONSchema>(
      links.map((index) => [
        `Link${String(index)}`,
        index === links.length - 1
          ? { type: "object", properties: { id: { type: "string" } } }
          : { $ref: `Link${String(index + 1)}` },
      ]),
    );
    const chained: TypeContext = {
      defs: new Map([...schemas.keys()].map((key) => [key, key])),
      schemas,
    };

    expect(
      typeExpression(
        { type: "object", required: ["id"], allOf: [{ $ref: "Link0" }] },
        chained,
      ),
    ).toBe("Link0 & { readonly id: string; readonly [key: string]: unknown; }");
  });

  it("requires a field only a union inside a definition declares", () => {
    // The search reads properties, allOf and references; a union inside the definition declares
    // the field in each branch, and which branch holds is not known here. The field is still one
    // every valid request carries, so the type asks for it and the reference says what it is.
    const schemas = new Map<string, JSONSchema>([
      [
        "Choice",
        {
          anyOf: [
            { type: "object", properties: { id: { type: "string" } } },
            { type: "object", properties: { id: { type: "number" } } },
          ],
        },
      ],
    ]);
    const choice: TypeContext = {
      defs: new Map([["Choice", "Choice"]]),
      schemas,
    };

    expect(
      typeExpression(
        { type: "object", required: ["id"], allOf: [{ $ref: "Choice" }] },
        choice,
      ),
    ).toBe(
      "Choice & { readonly id: unknown; readonly [key: string]: unknown; }",
    );
  });

  it("requires a field the schema never describes", () => {
    // `required` without a declaration anywhere: nothing can be said about the value, but a
    // request without it is one the validators reject, and the caller reads that from the type.
    expect(
      type({ type: "object", required: ["id"], additionalProperties: false }),
    ).toBe("{ readonly id: unknown; }");
  });

  it("ends the search where definitions refer to each other", () => {
    // Neither definition declares the field, and each leads back to the other. The search stops
    // there, and the field is named as `unknown`: the schema requires it either way.
    const schemas = new Map<string, JSONSchema>([
      ["Left", { $ref: "Right" }],
      ["Right", { $ref: "Left" }],
    ]);
    const mutual: TypeContext = {
      defs: new Map([...schemas.keys()].map((key) => [key, key])),
      schemas,
    };

    expect(
      typeExpression(
        { type: "object", required: ["id"], allOf: [{ $ref: "Left" }] },
        mutual,
      ),
    ).toBe("Left & { readonly id: unknown; readonly [key: string]: unknown; }");
  });

  it("keeps the constraints written beside a reference", () => {
    expect(
      type({
        $ref: "UserRecord",
        properties: { extra: { type: "string" } },
        required: ["extra"],
      }),
    ).toBe(
      "UserRecord & { readonly extra: string; readonly [key: string]: unknown; }",
    );
  });

  it("keeps a value the object keywords do not exclude", () => {
    // Object keywords constrain objects only, so a branch carrying them says nothing about
    // null; a schema that admits null must keep admitting it.
    expect(
      type({
        type: ["object", "null"],
        allOf: [{ properties: { id: { type: "string" } }, required: ["id"] }],
      }),
    ).toBe("{ readonly id: string; readonly [key: string]: unknown; } | null");

    // A branch that states `type: "object"` does exclude it.
    expect(
      type({
        type: ["object", "null"],
        allOf: [
          {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        ],
      }),
    ).toBe("{ readonly id: string; readonly [key: string]: unknown; }");
  });

  it("describes an object from its properties without a type", () => {
    expect(
      type({ properties: { id: { type: "string" } }, required: ["id"] }),
    ).toBe("{ readonly id: string; readonly [key: string]: unknown; }");
  });

  it("groups a compound element without reading its literals", () => {
    // A string literal can hold any punctuation; counting brackets in the text would take "<"
    // for a nested type and leave the union unparenthesised.
    expect(type({ type: "array", items: { enum: ["<", "closed"] } })).toBe(
      'readonly ("<" | "closed")[]',
    );
    expect(type({ type: "array", items: { enum: ["{", "}"] } })).toBe(
      'readonly ("{" | "}")[]',
    );
  });

  it("makes arrays readonly and groups a union of items", () => {
    expect(type({ type: "array", items: { type: "string" } })).toBe(
      "readonly string[]",
    );
    expect(type({ type: "array" })).toBe("readonly unknown[]");
    expect(type({ type: "array", items: { type: ["string", "null"] } })).toBe(
      "readonly (string | null)[]",
    );
  });

  it("brackets an array's element when it is not a single name", () => {
    // `readonly readonly T[][]` is not valid TypeScript, and `readonly T[][]` is a different
    // type; an element that is itself an array or a union needs brackets.
    expect(
      type({
        type: "array",
        items: { type: "array", items: { type: "string" } },
      }),
    ).toBe("readonly (readonly string[])[]");
    // In a union it needs none.
    expect(
      type({
        anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      }),
    ).toBe("readonly string[] | null");
  });

  it("names the elements a tuple prefix declares", () => {
    // `prefixItems` types the front of an array by position; `items` types what follows it.
    expect(
      type({
        type: "array",
        prefixItems: [{ type: "number" }],
        items: { type: "string" },
        minItems: 1,
        maxItems: 1,
      }),
    ).toBe("readonly [number]");

    expect(
      type({
        type: "array",
        prefixItems: [{ type: "number" }],
        items: { type: "string" },
        minItems: 1,
      }),
    ).toBe("readonly [number, ...string[]]");

    // Without a length to require them, a named element may be absent.
    expect(
      type({
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
      }),
    ).toBe("readonly [number?, string?, ...unknown[]]");

    // An optional element takes the brackets an element needs.
    expect(
      type({ type: "array", prefixItems: [{ type: ["string", "null"] }] }),
    ).toBe("readonly [(string | null)?, ...unknown[]]");
    expect(
      type({
        type: "array",
        prefixItems: [{ type: "array", items: { type: "number" } }],
      }),
    ).toBe("readonly [(readonly number[])?, ...unknown[]]");

    // Nothing is admitted past the names.
    expect(
      type({
        type: "array",
        prefixItems: [{ type: "number" }],
        items: false,
        minItems: 1,
      }),
    ).toBe("readonly [number]");
    expect(type({ type: "array", items: false })).toBe("readonly []");
  });

  it("admits the fields a pattern names", () => {
    // TypeScript has no pattern-keyed index signature, so the pattern's values widen the one it
    // has: a contract that dropped them would refuse an entry the gateway accepts.
    expect(
      type({
        type: "object",
        patternProperties: { "^x-": { type: "string" } },
        additionalProperties: false,
      }),
    ).toBe("{ readonly [key: string]: string | undefined; }");

    // With nothing said about the fields no pattern matches, the schema admits any value under
    // any other name, and so must the index signature.
    expect(
      type({
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        patternProperties: { "^x-": { type: "string" } },
      }),
    ).toBe("{ readonly id: number; readonly [key: string]: unknown; }");

    // Closed to everything else, the patterns are all a name can carry.
    expect(
      type({
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        patternProperties: { "^x-": { type: "string" } },
        additionalProperties: false,
      }),
    ).toBe(
      "{ readonly id: number; readonly [key: string]: string | number | undefined; }",
    );

    // An object that names no field and admits none is still closed.
    expect(type({ type: "object", additionalProperties: false })).toBe(
      "Record<string, never>",
    );
  });

  it("keeps null through a branch that admits it", () => {
    // Every part of an `allOf` holds at once, so a branch that says the value may be null keeps
    // null admissible for the composition around it.
    expect(
      type({
        allOf: [
          {
            type: "object",
            nullable: true,
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        ],
      }),
    ).toBe("{ readonly id: string; readonly [key: string]: unknown; } | null");
  });

  it("admits null where the schema says the value may be null", () => {
    // Ajv takes OpenAPI's `nullable` beside a type and validates null against it.
    expect(type({ type: "string", nullable: true })).toBe("string | null");
    expect(
      type({
        type: "object",
        nullable: true,
        properties: { id: { type: "string" } },
        required: ["id"],
      }),
    ).toBe("{ readonly id: string; readonly [key: string]: unknown; } | null");
  });

  it("turns an enum into a union of literals", () => {
    expect(type({ enum: ["active", "archived"] })).toBe(
      '"active" | "archived"',
    );
    expect(type({ enum: [1, true, null] })).toBe("1 | true | null");
    expect(type({ const: "fixed" })).toBe('"fixed"');
  });

  it("combines anyOf, oneOf and allOf", () => {
    expect(type({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe(
      "string | number",
    );
    expect(type({ oneOf: [{ type: "string" }, { type: "null" }] })).toBe(
      "string | null",
    );
    expect(type({ allOf: [{ $ref: "UserRecord" }, { type: "object" }] })).toBe(
      "UserRecord & Record<string, unknown>",
    );
  });

  it("names a shared definition rather than expanding it", () => {
    // A definition that refers to itself would not terminate if references expanded.
    expect(type({ $ref: "UserRecord" })).toBe("UserRecord");
    expect(type({ type: "array", items: { $ref: "UserRecord" } })).toBe(
      "readonly UserRecord[]",
    );
  });

  it("refuses a reference no definition declares", () => {
    expect(() => type({ $ref: "Missing" })).toThrow(/"Missing"/);
  });

  it("reads a schema nested as deep as anything written by hand", () => {
    // Fifty levels is beyond any gateway's input and still read in full: the bound is there for
    // what no one writes, not for a schema that is merely large.
    let schema: JSONSchema = { type: "string" };
    for (let index = 0; index < 50; index += 1) {
      schema = {
        type: "object",
        properties: { next: schema },
        required: ["next"],
        additionalProperties: false,
      };
    }

    expect(type(schema)).toMatch(/^\{ readonly next: \{ readonly next: /);
  });

  it("refuses a schema nested deeper than it reads", () => {
    // Nothing is emitted for it: a contract full of `unknown` would compile and hide the schema
    // that caused it.
    let schema: JSONSchema = { type: "string" };
    for (let index = 0; index < 120; index += 1) {
      schema = { type: "object", properties: { next: schema } };
    }

    expect(() => type(schema)).toThrow(/nests more than 100 levels deep/);
  });

  it("counts a union's branches as the nesting they are", () => {
    // Branches are read after the schema around them, so the depth they were written at travels
    // with them; without it a schema could nest through unions for ever and never reach the bound.
    let nested: JSONSchema = { type: "string" };
    for (let index = 0; index < 120; index += 1) nested = { anyOf: [nested] };

    expect(() => type(nested)).toThrow(/nests more than 100 levels deep/);

    // A union written beside another is not nesting: both are branches of the same schema.
    let wide: JSONSchema = { type: "string" };
    for (let index = 0; index < 30; index += 1) {
      wide = {
        anyOf: [wide, { type: "number" }],
        oneOf: [{ type: "object" }, { type: "null" }],
      };
    }
    expect(() => type(wide)).not.toThrow();
  });

  it("refuses a union branch that is the schema it is written in", () => {
    const loop: Record<string, unknown> = { type: "object" };
    loop["anyOf"] = [loop];

    expect(() => type(loop)).toThrow(/nests more than 100 levels deep/);
  });

  it("refuses a reference the contract cannot name", () => {
    // A pointer into the schema itself is one the validators resolve and this cannot: there is
    // no shared definition to name, and a type standing in for it would describe nothing.
    expect(() =>
      type({
        type: "object",
        $defs: { Body: { type: "object" } },
        properties: { payload: { $ref: "#/$defs/Body" } },
      }),
    ).toThrow(/names no shared definition/);
  });

  it("refuses a schema object that contains itself", () => {
    // Not a "$ref" cycle, which is read as a name: these are one object reachable from inside
    // itself, which a schema module can build and a reader cannot leave.
    const properties: Record<string, unknown> = { type: "object" };
    properties["properties"] = { self: properties };
    expect(() => type(properties)).toThrow(/nests more than 100 levels deep/);

    const composed: Record<string, unknown> = { type: "object" };
    composed["allOf"] = [composed];
    expect(() => type(composed)).toThrow(/nests more than 100 levels deep/);
  });

  it("admits everything the schema admits when it says nothing", () => {
    // Widening beyond what a keyword describes would be wrong; the validators decide.
    expect(type({})).toBe("unknown");
    expect(type(true)).toBe("unknown");
    expect(type({ type: "unheard-of" })).toBe("unknown");
    expect(type({ description: "no type at all" })).toBe("unknown");
  });

  it("reads a type list as a union", () => {
    expect(type({ type: ["string", "null"] })).toBe("string | null");
    expect(
      type({
        type: ["object", "null"],
        properties: { id: { type: "string" } },
        required: ["id"],
      }),
    ).toBe("{ readonly id: string; readonly [key: string]: unknown; } | null");
  });
});
