import { describe, expect, it } from "vitest";

import { type Conversion, convertSchema, type Side } from "./convert.ts";

function converting(side: Side) {
  const conversion: Conversion = {
    side,
    notes: new Set(),
    problems: [],
    refs: new Map(),
  };
  return {
    conversion,
    convert: (schema: unknown) => convertSchema(schema, "here", conversion),
  };
}

const asInput = (schema: unknown) => converting("input").convert(schema);
const asOutput = (schema: unknown) => converting("output").convert(schema);

describe("convertSchema, on either side", () => {
  it("leaves out what OpenAPI says about a schema that JSON Schema has no keyword for", () => {
    expect(
      asOutput({
        type: "string",
        description: "kept",
        example: "a",
        examples: ["a"],
        xml: { name: "x" },
        externalDocs: { url: "https://docs.test" },
        discriminator: { propertyName: "kind" },
        "x-internal": true,
      }),
    ).toEqual({ type: "string", description: "kept" });
  });

  it("reads nullable as a type, and as nothing where there is no type for it to add to", () => {
    expect(asInput({ type: "string", nullable: true })).toEqual({
      type: ["string", "null"],
    });
    expect(asInput({ nullable: true })).toEqual({});
    expect(
      asOutput({ type: "object", additionalProperties: { nullable: true } }),
    ).toEqual({ type: "object", additionalProperties: {} });
  });

  it("gives a schema the type its keywords are those of, first, and says so", () => {
    const { convert, conversion } = converting("output");

    expect(
      convert({ properties: { id: { type: "string" } }, required: ["id"] }),
    ).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(Object.keys(convert({ items: {} }) as object)[0]).toBe("type");
    expect([...conversion.notes]).toEqual([
      "here declares no type; its keywords are those of an object, so it was given that type",
      "here declares no type; its keywords are those of an array, so it was given that type",
    ]);
  });

  it("gives no type where another part declares it, or where the keywords disagree", () => {
    expect(
      asOutput({ $ref: "#/components/schemas/A", required: ["id"] }),
    ).toEqual({ $ref: "A", required: ["id"] });
    expect(asOutput({ allOf: [{ required: ["id"] }] })).toEqual({
      allOf: [{ required: ["id"] }],
    });
    expect(asOutput({ enum: ["a"] })).toEqual({ enum: ["a"] });
    expect(asInput({ minLength: 1, minimum: 1 })).toEqual({
      minLength: 1,
      minimum: 1,
    });
  });

  it("drops a keyword the declared type says nothing about, and says so", () => {
    const { convert, conversion } = converting("input");

    expect(
      convert({
        type: "array",
        additionalProperties: false,
        items: { type: "string" },
      }),
    ).toEqual({ type: "array", items: { type: "string" } });
    expect(convert({ type: "integer", minimum: 1 })).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect([...conversion.notes]).toEqual([
      'here declares "additionalProperties" beside type array, which it says nothing about; it was dropped',
    ]);
  });

  it("names a shared definition by its own name, and refuses a reference to anything else", () => {
    const { convert, conversion } = converting("input");

    expect(
      convert({
        type: "array",
        items: { $ref: "#/components/schemas/Person" },
      }),
    ).toEqual({ type: "array", items: { $ref: "Person" } });
    expect([...conversion.refs.keys()]).toEqual(["Person"]);

    convert({ $ref: "https://elsewhere.test/schema.json" });
    convert({ $ref: "#/components/schemas/Person/properties/name" });
    expect(conversion.problems).toHaveLength(2);
    expect(conversion.problems[0]).toContain(
      "only a schema in the document's own components can be referred to",
    );
  });

  it("passes what is not a schema object through as it is", () => {
    expect(asInput(true)).toBe(true);
    expect(asOutput(false)).toBe(false);
  });
});

describe("convertSchema, for an input", () => {
  it("closes every object the upstream left open, last, and keeps what it said of the rest", () => {
    const converted = asInput({
      type: "object",
      properties: {
        nested: { type: "object", properties: { a: { type: "string" } } },
        bag: { type: "object", additionalProperties: { type: "string" } },
        open: { type: "object", additionalProperties: true },
      },
    });

    expect(converted).toEqual({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
        },
        bag: { type: "object", additionalProperties: { type: "string" } },
        open: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    });
    expect(Object.keys(converted as object).at(-1)).toBe(
      "additionalProperties",
    );
  });

  it("leaves the parts of a composition open, and says so", () => {
    const { convert, conversion } = converting("input");

    expect(
      convert({
        allOf: [
          { $ref: "#/components/schemas/Group" },
          { type: "object", properties: { action: { type: "string" } } },
        ],
      }),
    ).toEqual({
      allOf: [
        { $ref: "Group" },
        { type: "object", properties: { action: { type: "string" } } },
      ],
    });
    expect([...conversion.notes][0]).toContain(
      "is part of a composition, so it is left open",
    );
  });

  it("holds a caller to every constraint the upstream states", () => {
    const strict = {
      type: "string",
      minLength: 16,
      maxLength: 16,
      pattern: "^[A-Z9]{5}",
      format: "uuid",
      enum: ["TYRR", "TYRPC"],
    };

    expect(asInput(strict)).toEqual(strict);
  });
});

describe("convertSchema, for an outcome", () => {
  it("holds an upstream to its shape, and to nothing a minor release would change", () => {
    expect(
      asOutput({
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 43,
            pattern: "^\\S",
          },
          born: { type: "string", format: "date" },
          points: { type: "integer", minimum: 0, maximum: 12 },
          tags: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string" },
          },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        born: { type: "string" },
        points: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("turns the values it lists into the values it knows of, where the type was", () => {
    expect(
      asOutput({
        description: "Where a licence stands",
        type: "string",
        enum: ["Valid", "Revoked"],
      }),
    ).toEqual({
      description: "Where a licence stands",
      anyOf: [{ enum: ["Valid", "Revoked"] }, { type: "string" }],
    });
    expect(asOutput({ type: "integer", enum: [1, 2] })).toEqual({
      anyOf: [{ enum: [1, 2] }, { type: "integer" }],
    });
    expect(asOutput({ type: ["string", "null"], enum: ["a", null] })).toEqual({
      anyOf: [{ enum: ["a"] }, { type: "string" }, { type: "null" }],
    });

    // Nothing of its type is listed, so there is nothing to know of: an empty `enum` beside the
    // types would be a schema Ajv refuses, and generation would stop on it.
    expect(asOutput({ type: "string", nullable: true, enum: [null] })).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("leaves a list it cannot open closed, and says what that costs", () => {
    const { convert, conversion } = converting("output");

    expect(convert({ enum: ["a", 1] })).toEqual({ enum: ["a", 1] });
    expect(convert({ type: "boolean", enum: [true] })).toEqual({
      type: "boolean",
      enum: [true],
    });
    expect([...conversion.notes][0]).toContain(
      "a value the upstream adds will fail the response",
    );
    expect(asOutput({ type: "string", const: "fixed" })).toEqual({
      type: "string",
      const: "fixed",
    });
  });

  it("keeps the one value that tells a union's branches apart", () => {
    const branch = (kind: string, status: string[]) => ({
      type: "object",
      properties: {
        kind: { type: "string", enum: [kind] },
        status: { type: "string", enum: status },
      },
      required: ["kind"],
    });

    expect(
      asOutput({ oneOf: [branch("card", ["a", "b"]), branch("cash", ["c"])] }),
    ).toEqual({
      oneOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["card"] },
            status: { anyOf: [{ enum: ["a", "b"] }, { type: "string" }] },
          },
          required: ["kind"],
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["cash"] },
            status: { type: "string", enum: ["c"] },
          },
          required: ["kind"],
        },
      ],
    });
  });

  it("keeps a name an object literal would read as its prototype", () => {
    // Assigned, the key would set the prototype: it would go missing, the check that refuses
    // that name in a version would never see it, and what it held would answer for every lookup
    // the schema did not satisfy itself — `additionalProperties` among them, which is what
    // closes an input.
    const upstream = JSON.parse(
      '{"type":"object","properties":{"a":{"type":"string"}},"__proto__":{"additionalProperties":true}}',
    ) as Record<string, unknown>;
    const converted = asInput(upstream) as Record<string, unknown>;

    expect(Object.hasOwn(converted, "__proto__")).toBe(true);
    expect(converted.additionalProperties).toBe(false);
  });

  it("holds a schema to what the upstream wrote where its effect turns around", () => {
    // Under a `not`, closing an object leaves the subject matching less and the whole matching
    // more, and dropping a bound leaves the subject matching more and the whole matching less.
    const subject = {
      type: "object",
      properties: { note: { type: "string", maxLength: 3 } },
      required: ["note"],
    };

    expect(asInput({ type: "object", not: subject })).toEqual({
      type: "object",
      not: subject,
      additionalProperties: false,
    });
    expect(asOutput({ type: "object", not: subject })).toEqual({
      type: "object",
      not: subject,
    });
  });

  it("refuses a schema there that needs a type it would have to supply", () => {
    // Giving it the type its keywords imply narrows it, which there widens the whole, and a
    // validator refuses the keyword with no type at all: there is nothing safe to write.
    const output = converting("output");
    output.convert({ type: "object", not: { maxLength: 3 } });

    expect(output.conversion.problems).toEqual([
      "here.not declares no type beside keywords that need one, somewhere a change in what it admits turns around; write the type the upstream means",
    ]);
  });

  it("opens a union's branches only where a field tells them apart", () => {
    const branch = (kind: unknown, extra: object = {}) => ({
      type: "object",
      properties: {
        kind,
        status: { type: "string", enum: ["a", "b"] },
      },
      required: ["kind"],
      ...extra,
    });
    const tag = (kind: string) => branch({ type: "string", enum: [kind] });

    // Told apart by `kind`, which goes on telling them apart whatever else is opened.
    const tagged = asOutput({ oneOf: [tag("card"), tag("cash")] }) as {
      oneOf: { properties: { status: unknown } }[];
    };
    expect(tagged.oneOf[0]?.properties.status).toEqual({
      anyOf: [{ enum: ["a", "b"] }, { type: "string" }],
    });

    // Nothing does, so a branch that came to admit more could take a value from the other and
    // leave the whole refusing what two of its branches match.
    for (const untagged of [
      // The same value in both.
      { oneOf: [tag("card"), tag("card")] },
      // A tag a branch may leave out, which a value omitting it matches in every branch.
      {
        oneOf: [
          { ...tag("card"), required: [] },
          { ...tag("cash"), required: [] },
        ],
      },
      // Objects for values: two that are the same value are not the same text, and a tag read
      // as text would take them for two.
      {
        oneOf: [
          branch({ const: { a: 1, b: 2 } }),
          branch({ const: { b: 2, a: 1 } }),
        ],
      },
    ]) {
      expect(asOutput(untagged), JSON.stringify(untagged)).toEqual(untagged);
    }

    // Branches written as names, whose fields are not here to read: each is held to what the
    // upstream wrote, which is said where the definition itself is converted.
    const named = converting("output");
    named.convert({
      oneOf: [
        { $ref: "#/components/schemas/Card" },
        { $ref: "#/components/schemas/Cash" },
      ],
    });
    expect(named.conversion.refs.get("Card")).toMatchObject({
      reversed: true,
    });
  });

  it("keeps a count that starts at none, which starting at one would not say", () => {
    // Left out, `minContains` is one: an array with no match at all passes the upstream and
    // would fail an outcome that dropped the zero.
    const counted = {
      type: "array",
      contains: { type: "string" },
      minContains: 0,
      maxContains: 1,
    };

    expect(asOutput(counted)).toEqual(counted);
    // One that counts from one says what saying nothing says, so it goes.
    expect(
      asOutput({ type: "array", contains: { type: "string" }, minContains: 2 }),
    ).toEqual({ type: "array", contains: { type: "string" } });
  });

  it("closes an ordinary object inside a tuple", () => {
    expect(
      asInput({
        type: "array",
        prefixItems: [
          { type: "object", properties: { a: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
        },
      ],
    });
  });

  it("reads nullable by what it says, in either order", () => {
    const written = (text: string) => asInput(JSON.parse(text));

    expect(written('{"type":"string","nullable":false}')).toEqual({
      type: "string",
    });
    expect(written('{"nullable":false,"type":"string"}')).toEqual({
      type: "string",
    });
    expect(written('{"type":"string","nullable":true}')).toEqual({
      type: ["string", "null"],
    });
    expect(written('{"nullable":true,"type":"string"}')).toEqual({
      type: ["string", "null"],
    });
    // What 3.1 writes instead, which passes through as it stands.
    expect(asInput({ type: ["string", "null"] })).toEqual({
      type: ["string", "null"],
    });
  });

  it("records where a definition is referred to from, not only that it is", () => {
    const input = converting("input");
    input.convert({
      allOf: [
        { $ref: "#/components/schemas/Person" },
        { type: "object", properties: { extra: { type: "string" } } },
      ],
    });
    expect(input.conversion.refs.get("Person")).toMatchObject({
      composed: true,
    });

    const output = converting("output");
    output.convert({
      oneOf: [
        { $ref: "#/components/schemas/Card" },
        { $ref: "#/components/schemas/Cash" },
      ],
    });
    // Branches written as names: what tells them apart is not here to read, so each is held to
    // what the upstream wrote.
    expect(output.conversion.refs.get("Card")).toMatchObject({
      unionBranch: true,
      reversed: true,
    });
  });

  it("says when a field is on the side its upstream marked it off", () => {
    const input = converting("input");
    input.convert({ type: "string", readOnly: true });
    const output = converting("output");
    output.convert({ type: "string", writeOnly: true });

    expect([...input.conversion.notes][0]).toContain("marked readOnly");
    expect([...output.conversion.notes][0]).toContain("marked writeOnly");
  });
});
