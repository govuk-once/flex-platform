import { describe, expect, it } from "vitest";

import { narrowingProblems, narrowInto } from "./narrow.ts";

const BAG = { type: "object", properties: {}, additionalProperties: {} };

function narrowing(derived: unknown, stated: unknown) {
  const problems: string[] = [];
  return { result: narrowInto(derived, stated, "here", problems), problems };
}

describe("narrowInto", () => {
  it("leaves a schema nothing is stated of as the document wrote it", () => {
    expect(narrowing(BAG, undefined).result).toBe(BAG);
  });

  it("states the shape of an object the document says may be any", () => {
    const shape = {
      type: "object",
      properties: { consentStatus: { type: "string" } },
      required: ["consentStatus"],
      additionalProperties: false,
    };

    expect(narrowing(BAG, shape).result).toEqual(shape);
    expect(narrowing({ type: "object" }, shape).result).toEqual(shape);
    expect(
      narrowing({ ...BAG, description: "What is kept" }, shape).result,
    ).toEqual({ description: "What is kept", ...shape });
  });

  it("sets what is stated of a field into the object the document describes around it", () => {
    const { result, problems } = narrowing(
      {
        type: "object",
        properties: { data: BAG, configuration: { type: "object" } },
        required: ["data"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          data: { type: "object", properties: { groups: { type: "array" } } },
        },
        required: ["data", "configuration"],
      },
    );

    expect(result).toEqual({
      type: "object",
      properties: {
        data: { type: "object", properties: { groups: { type: "array" } } },
        configuration: { type: "object" },
      },
      required: ["data", "configuration"],
      additionalProperties: false,
    });
    expect(Object.keys(result as object)).toEqual([
      "type",
      "properties",
      "required",
      "additionalProperties",
    ]);
    expect(problems).toEqual([]);
  });

  it("reaches into the elements of a list", () => {
    expect(
      narrowing(
        { type: "array", items: BAG },
        {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
        },
      ).result,
    ).toEqual({
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } } },
    });
  });

  it("closes an object the document left open, and adds a field to one it did", () => {
    expect(
      narrowing(
        { type: "object", properties: { a: { type: "string" } } },
        {
          type: "object",
          properties: { b: { type: "string" } },
          additionalProperties: false,
        },
      ).result,
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("refuses a field the document's object has no room for, which would be admitting more", () => {
    const { problems } = narrowing(
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
      },
      { type: "object", properties: { b: { type: "string" } } },
    );

    expect(problems).toEqual([
      "here.b is narrowed, and the document has no such field there",
    ]);
  });

  it.each([
    ["a bag and what is not an object", BAG, { type: "string" }],
    ["a scalar", { type: "string" }, { type: "string", minLength: 1 }],
    ["a composition", { anyOf: [{ type: "string" }] }, { type: "string" }],
    [
      "an object and a constraint it cannot weigh",
      {
        type: "object",
        properties: {},
        additionalProperties: { type: "string" },
      },
      { type: "object", additionalProperties: { type: "number" } },
    ],
    [
      "an object and a keyword it does not read",
      { type: "object", properties: { a: {} } },
      { type: "object", minProperties: 1 },
    ],
  ])(
    "sets %s side by side, where both hold whatever they say",
    (_what, derived, stated) => {
      expect(narrowing(derived, stated).result).toEqual({
        allOf: [derived, stated],
      });
    },
  );

  it("keeps what held a name the document did not declare", () => {
    // A field declared on an object is exempt from its `additionalProperties`, so stating one
    // on a dictionary would take away what held every name in it: a dictionary of strings does
    // not gain a number by naming one of its keys.
    const dictionary = {
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
    };

    expect(
      narrowing(dictionary, {
        type: "object",
        properties: { code: { type: "integer" } },
      }).result,
    ).toEqual({
      type: "object",
      properties: {
        code: { allOf: [{ type: "string" }, { type: "integer" }] },
      },
      additionalProperties: { type: "string" },
    });

    // Where the document said nothing of the other names, what is stated stands on its own.
    expect(
      narrowing(
        { type: "object", properties: {} },
        { type: "object", properties: { code: { type: "integer" } } },
      ).result,
    ).toEqual({
      type: "object",
      properties: { code: { type: "integer" } },
    });
  });

  it("does not put an object that admits null in place of one that does not", () => {
    // An object of any shape admits objects and nothing else. Replacing it with a schema that
    // also admits null would admit what it did not, so the two are set side by side instead.
    const bag = { type: "object" };
    const nullable = {
      type: "object",
      nullable: true,
      properties: { a: { type: "string" } },
    };

    expect(narrowing(bag, nullable).result).toEqual({ allOf: [bag, nullable] });
    // One that admits objects and nothing else still takes its place.
    expect(
      narrowing(bag, { type: "object", properties: { a: { type: "string" } } })
        .result,
    ).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("takes a schema written as a flag, which is how a shape says it ends", () => {
    // `false` admits no value and `true` every one: a tuple says it ends with the first, and an
    // object refuses a field with it.
    const tuple = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: false,
    };
    const refusing = { type: "object", properties: { forbidden: false } };
    const problems: string[] = [];

    narrowingProblems(tuple, "here", problems);
    narrowingProblems(refusing, "here", problems);

    expect(problems).toEqual([]);
  });

  it("keeps what a narrowing says of what it narrows over what the document says", () => {
    expect(
      narrowing(
        {
          type: "object",
          description: "The document's",
          properties: { id: { type: "string" } },
        },
        {
          type: "object",
          description: "The operation's",
          required: ["id"],
        },
      ).result,
    ).toEqual({
      type: "object",
      description: "The operation's",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(
      narrowing(
        { type: "array", items: BAG },
        { type: "array", title: "Groups", items: { type: "object" } },
      ).result,
    ).toEqual({ type: "array", items: { type: "object" }, title: "Groups" });
  });

  it("refuses a reference of either kind, which a narrowing has nothing to point at", () => {
    const problems: string[] = [];
    narrowingProblems({ $ref: "#/x" }, "here", problems);
    narrowingProblems(
      { type: "object", properties: { a: { $dynamicRef: "#node" } } },
      "there",
      problems,
    );

    expect(problems).toEqual([
      'here must be written out; it has nothing a "$ref" could refer to',
      'there.properties.a must be written out; it has nothing a "$dynamicRef" could refer to',
    ]);
  });
});
