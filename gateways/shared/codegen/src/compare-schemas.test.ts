import type { GatewaySchemas, JSONSchema } from "@repo/gateway-types";
import { describe, expect, it } from "vitest";

import {
  checkVersions,
  compareSchemas,
  SchemaCompatibilityError,
} from "./compare-schemas.ts";

type Defs = Record<string, JSONSchema>;

// One operation, so a case states only the schema it is about.
const asInput = (input: JSONSchema, defs?: Defs): GatewaySchemas => ({
  ...(defs === undefined ? {} : { defs }),
  operations: { op: { input, outcomes: { ok: { type: "null" } } } },
});

const asOutcome = (ok: JSONSchema, defs?: Defs): GatewaySchemas => ({
  ...(defs === undefined ? {} : { defs }),
  operations: { op: { input: { type: "object" }, outcomes: { ok } } },
});

const input = (previous: JSONSchema, next: JSONSchema) =>
  compareSchemas(asInput(previous), asInput(next));
const outcome = (previous: JSONSchema, next: JSONSchema) =>
  compareSchemas(asOutcome(previous), asOutcome(next));

const person = (extra: JSONSchema = {}): JSONSchema => ({
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name"],
  additionalProperties: false,
  ...extra,
});

describe("compareSchemas", () => {
  describe("what is not a difference", () => {
    it("finds nothing between a version and itself", () => {
      expect(input(person(), person())).toEqual({
        breaking: [],
        compatible: [],
      });
    });

    it("reads past annotations, wherever a schema carries them", () => {
      const annotated = person({
        description: "Someone",
        title: "Person",
        deprecated: true,
        examples: [{ name: "Ann" }],
        properties: {
          name: { type: "string", description: "What they are called" },
          age: { type: "integer", default: 0 },
        },
      });

      expect(input(person(), annotated)).toEqual({
        breaking: [],
        compatible: [],
      });
      expect(outcome(annotated, person())).toEqual({
        breaking: [],
        compatible: [],
      });
    });

    it("reads a property named like an annotation as a property", () => {
      const { breaking } = input(
        { type: "object", properties: { description: { type: "string" } } },
        { type: "object", properties: { description: { type: "number" } } },
      );

      expect(breaking).toEqual([
        "operations.op.input.properties.description.type: changed from string to number",
      ]);
    });

    it("reads past the order things are written in", () => {
      const previous: JSONSchema = {
        type: ["string", "null"],
        enum: ["a", "b", null],
      };
      const next: JSONSchema = {
        enum: [null, "b", "a"],
        type: ["null", "string"],
      };

      expect(input(previous, next)).toEqual({ breaking: [], compatible: [] });
      expect(
        input(
          person({ required: ["name", "age"] }),
          person({ required: ["age", "name"] }),
        ),
      ).toEqual({ breaking: [], compatible: [] });
    });

    it("reads a number beside an integer as a number", () => {
      expect(
        input({ type: ["number", "integer"] }, { type: "number" }),
      ).toEqual({ breaking: [], compatible: [] });
    });
  });

  describe("an input, which may come to accept more and never less", () => {
    it.each<[string, JSONSchema, JSONSchema, string]>([
      [
        "a field that becomes required",
        person(),
        person({ required: ["name", "age"] }),
        'operations.op.input.required: "age" is now required',
      ],
      [
        "a field that is removed",
        person(),
        person({ properties: { name: { type: "string" } } }),
        "operations.op.input.properties.age: was removed",
      ],
      [
        "a type that admits less",
        { type: ["string", "null"] },
        { type: "string" },
        "operations.op.input.type: changed from null | string to string",
      ],
      [
        "a number that must now be whole",
        { type: "number" },
        { type: "integer" },
        "operations.op.input.type: changed from number to integer",
      ],
      [
        "a type where there was none",
        {},
        { type: "string" },
        "operations.op.input.type: changed from any type to string",
      ],
      [
        "one type for another",
        { type: "string" },
        { type: "number" },
        "operations.op.input.type: changed from string to number",
      ],
      [
        "a listed value that is removed",
        { enum: ["a", "b"] },
        { enum: ["a"] },
        'operations.op.input.enum: removed "b"',
      ],
      [
        "a list of values where any was taken",
        { type: "string" },
        { type: "string", enum: ["a"] },
        "operations.op.input.enum: is now limited to the values listed",
      ],
      [
        "a lower bound that is raised",
        { type: "integer", minimum: 1 },
        { type: "integer", minimum: 2 },
        "operations.op.input.minimum: changed from 1 to 2",
      ],
      [
        "an upper bound that is lowered",
        { type: "string", maxLength: 10 },
        { type: "string", maxLength: 5 },
        "operations.op.input.maxLength: changed from 10 to 5",
      ],
      [
        "a bound where there was none",
        { type: "string" },
        { type: "string", minLength: 1 },
        "operations.op.input.minLength: is now 1",
      ],
      [
        "a pattern where there was none",
        { type: "string" },
        { type: "string", pattern: "^a" },
        'operations.op.input.pattern: is now "^a"',
      ],
      [
        "a pattern that is changed, whichever way it leans",
        { type: "string", pattern: "^a" },
        { type: "string", pattern: "^[ab]" },
        'operations.op.input.pattern: changed from "^a" to "^[ab]"',
      ],
      [
        "a format where there was none",
        { type: "string" },
        { type: "string", format: "uuid" },
        'operations.op.input.format: is now "uuid"',
      ],
      [
        "an object that closes",
        { type: "object" },
        { type: "object", additionalProperties: false },
        "operations.op.input.additionalProperties: now admits nothing",
      ],
      [
        "a field an open object took any value under",
        { type: "object" },
        { type: "object", properties: { note: { type: "string" } } },
        "operations.op.input.properties.note: was added",
      ],
      [
        "elements that must now be unique",
        { type: "array" },
        { type: "array", uniqueItems: true },
        "operations.op.input.uniqueItems: items must now be unique",
      ],
      [
        "an element type that admits less",
        { type: "array", items: { type: ["string", "null"] } },
        { type: "array", items: { type: "string" } },
        "operations.op.input.items.type: changed from null | string to string",
      ],
      [
        "a change deep inside it",
        person({ properties: { name: { type: "string" }, age: {} } }),
        person(),
        "operations.op.input.properties.age.type: changed from any type to integer",
      ],
    ])("refuses %s", (_what, previous, next, problem) => {
      expect(input(previous, next).breaking).toEqual([problem]);
    });

    it.each<[string, JSONSchema, JSONSchema, string]>([
      [
        "a field that stops being required",
        person({ required: ["name", "age"] }),
        person(),
        'operations.op.input.required: "age" is no longer required',
      ],
      [
        "an optional field a closed object now takes",
        person(),
        person({
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
            note: { type: "string" },
          },
        }),
        "operations.op.input.properties.note: was added",
      ],
      [
        "a type that admits more",
        { type: "string" },
        { type: ["string", "null"] },
        "operations.op.input.type: changed from string to null | string",
      ],
      [
        "a type made nullable the OpenAPI way",
        { type: "string" },
        { type: "string", nullable: true },
        "operations.op.input.type: changed from string to null | string",
      ],
      [
        "a whole number that may now be any",
        { type: "integer" },
        { type: "number" },
        "operations.op.input.type: changed from integer to number",
      ],
      [
        "a listed value that is added",
        { enum: ["a"] },
        { enum: ["a", "b"] },
        'operations.op.input.enum: added "b"',
      ],
      [
        "one value that becomes a list holding it",
        { const: "a" },
        { enum: ["a", "b"] },
        'operations.op.input.enum: added "b"',
      ],
      [
        "a lower bound that is lowered",
        { type: "integer", minimum: 2 },
        { type: "integer", minimum: 1 },
        "operations.op.input.minimum: changed from 2 to 1",
      ],
      [
        "a bound that is removed",
        { type: "string", maxLength: 5 },
        { type: "string" },
        "operations.op.input.maxLength: is no longer 5",
      ],
      [
        "a pattern that is removed",
        { type: "string", pattern: "^a" },
        { type: "string" },
        'operations.op.input.pattern: is no longer "^a"',
      ],
      [
        "an object that opens",
        { type: "object", additionalProperties: false },
        { type: "object" },
        "operations.op.input.additionalProperties: no longer admits nothing",
      ],
    ])("accepts %s", (_what, previous, next, change) => {
      expect(input(previous, next)).toEqual({
        breaking: [],
        compatible: [change],
      });
    });
  });

  describe("an outcome, which may come to promise more and never less", () => {
    it.each<[string, JSONSchema, JSONSchema, string]>([
      [
        "a field that is removed",
        person(),
        person({ properties: { name: { type: "string" } } }),
        "operations.op.outcomes.ok.properties.age: was removed",
      ],
      [
        "a field that stops being required",
        person(),
        person({ required: [] }),
        'operations.op.outcomes.ok.required: "name" is no longer required',
      ],
      [
        "a type that admits more",
        { type: "string" },
        { type: ["string", "null"] },
        "operations.op.outcomes.ok.type: changed from string to null | string",
      ],
      [
        "a listed value that is added, which a caller's switch does not cover",
        { type: "string", enum: ["a"] },
        { type: "string", enum: ["a", "b"] },
        'operations.op.outcomes.ok.enum: added "b"',
      ],
      [
        "a bound that is loosened, where an outcome still carries one",
        { type: "string", maxLength: 5 },
        { type: "string", maxLength: 10 },
        "operations.op.outcomes.ok.maxLength: changed from 5 to 10",
      ],
    ])("refuses %s", (_what, previous, next, problem) => {
      expect(outcome(previous, next).breaking).toEqual([problem]);
    });

    it.each<[string, JSONSchema, JSONSchema, string]>([
      [
        "a field that is added, even to an object that was closed",
        person(),
        person({
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
            email: { type: "string" },
          },
        }),
        "operations.op.outcomes.ok.properties.email: was added",
      ],
      [
        "a field that becomes required",
        person(),
        person({ required: ["name", "age"] }),
        'operations.op.outcomes.ok.required: "age" is now required',
      ],
      [
        "a type that admits less",
        { type: ["string", "null"] },
        { type: "string" },
        "operations.op.outcomes.ok.type: changed from null | string to string",
      ],
      [
        "a listed value that is removed",
        { enum: ["a", "b"] },
        { enum: ["a"] },
        'operations.op.outcomes.ok.enum: removed "b"',
      ],
      [
        "an object that opens to what a caller is never offered",
        { type: "object", additionalProperties: false },
        { type: "object" },
        "operations.op.outcomes.ok.additionalProperties: changed from false to true",
      ],
    ])("accepts %s", (_what, previous, next, change) => {
      expect(outcome(previous, next)).toEqual({
        breaking: [],
        compatible: [change],
      });
    });

    const status = (...known: string[]): JSONSchema => ({
      anyOf: [{ enum: known }, { type: "string" }],
    });

    it("accepts a value an open enum comes to know, since it took any string already", () => {
      expect(outcome(status("Valid"), status("Valid", "Revoked"))).toEqual({
        breaking: [],
        compatible: [
          "operations.op.outcomes.ok.anyOf: lists different known values of a type it admits in full",
        ],
      });
    });

    it("refuses a closed enum that opens, which a caller's switch did not allow for", () => {
      const { breaking } = outcome(
        { type: "string", enum: ["Valid"] },
        status("Valid"),
      );

      expect(breaking).toContain(
        "operations.op.outcomes.ok.enum: is no longer limited to the values listed",
      );
    });

    it("does not take a listed value for a known one when its type is not admitted in full", () => {
      const { breaking } = outcome(
        { anyOf: [{ enum: [1] }, { type: "string" }] },
        { anyOf: [{ enum: [1, 2] }, { type: "string" }] },
      );

      expect(breaking).toEqual([
        "operations.op.outcomes.ok.anyOf.0.enum: added 2",
      ]);
    });
  });

  describe("operations and outcomes", () => {
    const both: GatewaySchemas = {
      operations: {
        first: { input: {}, outcomes: { ok: {} } },
        second: { input: {}, outcomes: { ok: {} } },
      },
    };
    const one: GatewaySchemas = {
      operations: { first: { input: {}, outcomes: { ok: {} } } },
    };

    it("accepts an operation that is added and refuses one that is removed", () => {
      expect(compareSchemas(one, both)).toEqual({
        breaking: [],
        compatible: ["operations.second: was added"],
      });
      expect(compareSchemas(both, one)).toEqual({
        breaking: ["operations.second: was removed"],
        compatible: [],
      });
    });

    it("refuses an outcome that is added as well as one that is removed", () => {
      const more: GatewaySchemas = {
        operations: {
          first: { input: {}, outcomes: { ok: {}, accepted: {} } },
        },
      };

      expect(compareSchemas(one, more).breaking).toEqual([
        "operations.first.outcomes.accepted: was added",
      ]);
      expect(compareSchemas(more, one).breaking).toEqual([
        "operations.first.outcomes.accepted: was removed",
      ]);
    });
  });

  describe("shared definitions", () => {
    const ref = (name: string): JSONSchema => ({ $ref: name });

    it("reads a definition once, however many places refer to it", () => {
      const twice: JSONSchema = {
        type: "object",
        properties: { a: ref("Person"), b: ref("Person") },
      };

      const { breaking } = compareSchemas(
        asInput(twice, { Person: person() }),
        asInput(twice, { Person: person({ required: ["name", "age"] }) }),
      );

      expect(breaking).toEqual([
        'defs.Person (as input).required: "age" is now required',
      ]);
    });

    it("reads a definition in each direction it is used in", () => {
      const schemas = (definition: JSONSchema): GatewaySchemas => ({
        defs: { Person: definition },
        operations: {
          op: { input: ref("Person"), outcomes: { ok: ref("Person") } },
        },
      });

      expect(
        compareSchemas(
          schemas(person()),
          schemas(person({ required: ["name", "age"] })),
        ),
      ).toEqual({
        breaking: ['defs.Person (as input).required: "age" is now required'],
        compatible: ['defs.Person (as output).required: "age" is now required'],
      });
    });

    it("refuses a definition that is removed, and accepts one that is added", () => {
      expect(
        compareSchemas(
          asInput({}, { Person: person() }),
          asInput({}, { Animal: person() }),
        ),
      ).toEqual({
        breaking: ["defs.Person: was removed"],
        compatible: ["defs.Animal: was added"],
      });
    });

    it("refuses another definition in the place of one a caller names", () => {
      const defs = { Person: person(), Animal: person() };

      expect(
        compareSchemas(
          asInput(ref("Person"), defs),
          asInput(ref("Animal"), defs),
        ).breaking,
      ).toEqual([
        'operations.op.input: refers to "Animal" where it referred to "Person"',
      ]);
    });

    it("reads a reference against what it stood for when one side writes it out", () => {
      const defs = { Person: person() };

      expect(
        compareSchemas(asInput(ref("Person"), defs), asInput(person(), defs)),
      ).toEqual({ breaking: [], compatible: [] });
      expect(
        compareSchemas(
          asInput(ref("Person"), defs),
          asInput(person({ required: ["name", "age"] }), defs),
        ).breaking,
      ).toEqual(['operations.op.input.required: "age" is now required']);
    });

    it("reads what is written beside a reference", () => {
      const defs = { Name: { type: "string" } };

      expect(
        compareSchemas(
          asInput({ $ref: "Name" }, defs),
          asInput({ $ref: "Name", minLength: 1 }, defs),
        ).breaking,
      ).toEqual(["operations.op.input.minLength: is now 1"]);
    });

    it("follows a definition that refers to itself without going round again", () => {
      const node = (extra: JSONSchema = {}): JSONSchema => ({
        type: "object",
        properties: { next: { $ref: "Node" } },
        ...extra,
      });

      expect(
        compareSchemas(
          asInput(ref("Node"), { Node: node() }),
          asInput(ref("Node"), { Node: node({ required: ["next"] }) }),
        ).breaking,
      ).toEqual(['defs.Node (as input).required: "next" is now required']);
    });

    it("reads a definition nothing refers to both ways, since either could be its use", () => {
      const { breaking, compatible } = compareSchemas(
        asInput({}, { Person: person() }),
        asInput({}, { Person: person({ required: ["name", "age"] }) }),
      );

      expect(breaking).toEqual([
        'defs.Person (as input).required: "age" is now required',
      ]);
      expect(compatible).toEqual([
        'defs.Person (as output).required: "age" is now required',
      ]);
    });
  });

  describe("composition and what it cannot place", () => {
    it("reads each part of an allOf, and refuses a different number of them", () => {
      expect(
        input(
          { allOf: [{ type: "object" }, { required: ["a"] }] },
          { allOf: [{ type: "object" }, { required: ["a", "b"] }] },
        ).breaking,
      ).toEqual(['operations.op.input.allOf.1.required: "b" is now required']);

      expect(
        input({ allOf: [{ type: "object" }] }, { allOf: [] }).breaking,
      ).toEqual(["operations.op.input.allOf: has 0 parts where it had 1"]);
    });

    it("reads a branch added to a union as admitting more", () => {
      const one: JSONSchema = { anyOf: [{ type: "object" }] };
      const two: JSONSchema = {
        anyOf: [{ type: "object" }, { type: "array" }],
      };

      expect(input(one, two).breaking).toEqual([]);
      expect(input(two, one).breaking).toEqual([
        "operations.op.input.anyOf: has 1 branches where it had 2",
      ]);
      expect(outcome(one, two).breaking).toEqual([
        "operations.op.outcomes.ok.anyOf: has 2 branches where it had 1",
      ]);
    });

    it("refuses a change in a keyword it does not read, and accepts none", () => {
      const previous: JSONSchema = {
        type: "object",
        patternProperties: { "^x-": { type: "string" } },
        not: { required: ["banned"] },
      };

      expect(input(previous, structuredClone(previous))).toEqual({
        breaking: [],
        compatible: [],
      });
      expect(
        input(previous, { ...previous, not: { required: ["other"] } }).breaking,
      ).toEqual([
        "operations.op.input.not: changed in a way that cannot be read as safe",
      ]);
    });

    it("reads a boolean schema as what it abbreviates", () => {
      const holding = (note: unknown): JSONSchema => ({
        type: "object",
        properties: { note },
      });

      expect(input(holding(true), holding({})).breaking).toEqual([]);
      expect(
        input(holding(true), holding({ type: "string" })).breaking,
      ).toEqual([
        "operations.op.input.properties.note.type: changed from any type to string",
      ]);
      expect(input(holding({}), holding(false)).breaking).toEqual([
        "operations.op.input.properties.note: now admits nothing",
      ]);
    });

    it("refuses what is not a schema rather than failing on it", () => {
      const holding = (note: unknown): JSONSchema => ({
        type: "object",
        properties: { note },
      });

      expect(input(holding(1), holding("two")).breaking).toEqual([
        "operations.op.input.properties.note: is not a schema on both sides",
      ]);
      expect(input({ minLength: "1" }, { minLength: "2" }).breaking).toEqual([
        "operations.op.input.minLength: is not a number on both sides",
      ]);
    });
  });

  describe("exclusive alternatives, which are not a union", () => {
    const disjoint: JSONSchema = {
      oneOf: [
        { type: "string", maxLength: 1 },
        { type: "string", minLength: 3 },
      ],
    };

    it("finds nothing in a oneOf whose branches say what they said", () => {
      expect(input(disjoint, structuredClone(disjoint))).toEqual({
        breaking: [],
        compatible: [],
      });
    });

    it("refuses a branch added, which can leave a value matching two", () => {
      // "a" matched the string branch alone and matches the constant as well now, so a oneOf
      // that admitted it refuses it. A branch added to an `anyOf` would only admit more.
      const two: JSONSchema = {
        oneOf: [{ type: "string" }, { type: "number" }],
      };
      const three: JSONSchema = {
        oneOf: [{ type: "string" }, { type: "number" }, { const: "a" }],
      };

      expect(input(two, three).breaking).toEqual([
        "operations.op.input.oneOf: has 3 branches where it had 2",
      ]);
      expect(outcome(two, three).breaking).toEqual([
        "operations.op.outcomes.ok.oneOf: has 3 branches where it had 2",
      ]);
    });

    it("refuses a branch widened, which can overlap the one beside it", () => {
      const overlapping: JSONSchema = {
        oneOf: [
          { type: "string", maxLength: 5 },
          { type: "string", minLength: 3 },
        ],
      };
      const changed =
        "changed, and a branch of a oneOf that changes can leave another matching too";

      expect(input(disjoint, overlapping).breaking).toEqual([
        `operations.op.input.oneOf.0: ${changed}`,
      ]);
      // Neither side of the call is the safe one: the same change runs both ways at once.
      expect(outcome(disjoint, overlapping).breaking).toEqual([
        `operations.op.outcomes.ok.oneOf.0: ${changed}`,
      ]);
      expect(outcome(overlapping, disjoint).breaking).toEqual([
        `operations.op.outcomes.ok.oneOf.0: ${changed}`,
      ]);
    });

    it("refuses a definition a branch refers to coming to admit more", () => {
      // The branches are written the same in both versions; what one of them names is not. "b"
      // matched the constant alone and matches the definition as well now, so a value the union
      // admitted it refuses. Freezing a `oneOf` is worth nothing if a reference walks through it.
      const choice = (values: string[]): GatewaySchemas => ({
        defs: { Choice: { enum: values } },
        operations: {
          op: {
            input: { oneOf: [{ $ref: "Choice" }, { const: "b" }] },
            outcomes: { ok: { type: "null" } },
          },
        },
      });

      expect(
        compareSchemas(choice(["a"]), choice(["a", "b"])).breaking,
      ).toEqual([
        'defs.Choice (where it is negated or conditional).enum: added "b"',
      ]);
      // Neither side of the call is the safe one, and taking a value away is no safer.
      expect(
        compareSchemas(choice(["a", "b"]), choice(["a"])).breaking,
      ).toHaveLength(1);
    });

    it("does not read the values beside a type as an open enum would be read", () => {
      // Under `anyOf` these are values of a type the union admits in full, and free to change.
      // Under `oneOf` they are values two branches both match.
      const before: JSONSchema = {
        oneOf: [{ enum: ["a"] }, { type: "string" }],
      };
      const after: JSONSchema = {
        oneOf: [{ enum: ["a", "b"] }, { type: "string" }],
      };

      expect(outcome(before, after).breaking).toHaveLength(1);
      expect(
        outcome({ anyOf: before.oneOf }, { anyOf: after.oneOf }).breaking,
      ).toEqual([]);
    });
  });

  describe("where a definition is used, and on which side", () => {
    const usedBothWays = (maxLength: number): GatewaySchemas => ({
      defs: { Text: { type: "string", maxLength } },
      operations: {
        op: { input: { $ref: "Text" }, outcomes: { ok: { $ref: "Text" } } },
      },
    });

    it("reads a definition used both ways as both, not as whichever came first", () => {
      // Widening it is what an input may do and an outcome may not, so the one reading must not
      // stand in for the other.
      expect(compareSchemas(usedBothWays(5), usedBothWays(9))).toEqual({
        breaking: ["defs.Text (as output).maxLength: changed from 5 to 9"],
        compatible: ["defs.Text (as input).maxLength: changed from 5 to 9"],
      });
    });

    it("reads a definition a changed union still names", () => {
      // The union changed by more than the comparison places, and the branch naming the
      // definition survived it. Having read the definition as an input is not having read it as
      // an outcome, so what it is used for is taken from the schemas rather than from how far
      // the comparison got before it stopped.
      const version = (maxLength: number, branches: JSONSchema[]) => ({
        defs: { Text: { type: "string", maxLength } },
        operations: {
          op: {
            input: { $ref: "Text" },
            outcomes: { ok: { anyOf: branches } },
          },
        },
      });

      const { breaking } = compareSchemas(
        version(5, [{ $ref: "Text" }, { type: "null" }]),
        version(9, [{ $ref: "Text" }]),
      );

      expect(breaking).toEqual([
        "defs.Text (as output).maxLength: changed from 5 to 9",
      ]);
    });

    it("reads a definition under a negation as neither side", () => {
      // `not` turns admitting more into admitting less, so what is safe for an input there is
      // what is safe for an outcome, and nothing here tells them apart.
      const version = (required: string[]): GatewaySchemas => ({
        defs: { Banned: { type: "object", required } },
        operations: {
          op: {
            input: { type: "object", not: { $ref: "Banned" } },
            outcomes: { ok: { type: "null" } },
          },
        },
      });

      expect(compareSchemas(version(["a"]), version([])).breaking).toEqual([
        'defs.Banned (where it is negated or conditional).required: "a" is no longer required',
      ]);
      expect(compareSchemas(version([]), version(["a"])).breaking).toEqual([
        'defs.Banned (where it is negated or conditional).required: "a" is now required',
      ]);
    });

    it("reads one under a condition, or under a contains that is counted", () => {
      const conditional = (maxLength: number): GatewaySchemas => ({
        defs: { Text: { type: "string", maxLength } },
        operations: {
          op: {
            input: { if: { $ref: "Text" }, then: { type: "string" } },
            outcomes: { ok: { type: "null" } },
          },
        },
      });
      const counted = (maxLength: number): GatewaySchemas => ({
        defs: { Text: { type: "string", maxLength } },
        operations: {
          op: {
            input: {
              type: "array",
              contains: { $ref: "Text" },
              maxContains: 2,
            },
            outcomes: { ok: { type: "null" } },
          },
        },
      });

      for (const version of [conditional, counted]) {
        expect(compareSchemas(version(5), version(9)).breaking).toEqual([
          "defs.Text (where it is negated or conditional).maxLength: changed from 5 to 9",
        ]);
      }
    });

    it("reads one under a contains that is not counted as the side it is on", () => {
      // Nothing caps the matches, so an element schema that admits more admits more arrays.
      const version = (maxLength: number): GatewaySchemas => ({
        defs: { Text: { type: "string", maxLength } },
        operations: {
          op: {
            input: { type: "array", contains: { $ref: "Text" } },
            outcomes: { ok: { type: "null" } },
          },
        },
      });

      expect(compareSchemas(version(5), version(9))).toEqual({
        breaking: [],
        compatible: ["defs.Text (as input).maxLength: changed from 5 to 9"],
      });
    });
  });

  describe("a name a dictionary already governed", () => {
    const dictionary: JSONSchema = {
      type: "object",
      additionalProperties: { type: "string" },
    };
    const declaring = (code: JSONSchema): JSONSchema => ({
      ...dictionary,
      properties: { code },
    });

    it("holds a declared outcome field to what the dictionary promised", () => {
      expect(
        outcome(dictionary, declaring({ type: "number" })).breaking,
      ).toEqual([
        "operations.op.outcomes.ok.properties.code.type: changed from string to number",
      ]);
    });

    it("finds nothing when the declaration says what the dictionary said", () => {
      expect(outcome(dictionary, declaring({ type: "string" }))).toEqual({
        breaking: [],
        compatible: [],
      });
      expect(input(dictionary, declaring({ type: "string" }))).toEqual({
        breaking: [],
        compatible: [],
      });
    });

    it("reads a pattern that governs the name, and refuses more than one", () => {
      const patterned = (patterns: Record<string, JSONSchema>): JSONSchema => ({
        type: "object",
        patternProperties: patterns,
      });
      const one = patterned({ "^c": { type: "string" } });

      expect(
        outcome(one, { ...one, properties: { code: { type: "number" } } })
          .breaking,
      ).toEqual([
        "operations.op.outcomes.ok.properties.code.type: changed from string to number",
      ]);

      const two = patterned({
        "^c": { type: "string" },
        e$: { type: "string" },
      });
      expect(
        outcome(two, { ...two, properties: { code: { type: "string" } } })
          .breaking,
      ).toEqual([
        "operations.op.outcomes.ok.properties.code: was added under more than one pattern, so what held the name cannot be read",
      ]);
    });

    it("still reads an added field as safe where nothing governed the name", () => {
      const open: JSONSchema = { type: "object" };

      expect(
        outcome(open, { ...open, properties: { code: { type: "number" } } }),
      ).toEqual({
        breaking: [],
        compatible: ["operations.op.outcomes.ok.properties.code: was added"],
      });
    });
  });

  describe("what is read as a schema and what is read as data", () => {
    it("reads a keyword's own names as names, not as annotations", () => {
      // `dependentRequired` lists property names, and a property may be named "description".
      // Read as a schema, the entry would be taken for an annotation and dropped, leaving two
      // versions that constrain differently looking the same.
      const previous: JSONSchema = { type: "object", dependentRequired: {} };
      const next: JSONSchema = {
        type: "object",
        dependentRequired: { description: ["a"] },
      };

      expect(input(previous, next).breaking).toEqual([
        "operations.op.input.dependentRequired: changed in a way that cannot be read as safe",
      ]);
      expect(outcome(next, previous).breaking).toEqual([
        "operations.op.outcomes.ok.dependentRequired: changed in a way that cannot be read as safe",
      ]);
    });

    it("reads the names a map of schemas holds as names", () => {
      // `patternProperties`, `dependentSchemas` and `$defs` each name their schemas, and a name
      // may be spelt like an annotation. Read as a schema itself, the map would lose the entry
      // and two versions constraining differently would compare equal.
      const holding = (keyword: string, held: JSONSchema): JSONSchema => ({
        type: "object",
        [keyword]: { description: held },
      });

      for (const keyword of [
        "patternProperties",
        "dependentSchemas",
        "$defs",
      ]) {
        expect(
          input(
            holding(keyword, { type: "string" }),
            holding(keyword, { type: "number" }),
          ).breaking,
          keyword,
        ).toEqual([
          `operations.op.input.${keyword}: changed in a way that cannot be read as safe`,
        ]);
      }
    });

    it("still reads past an annotation inside a schema a keyword holds", () => {
      const holding = (extra: JSONSchema): JSONSchema => ({
        type: "object",
        propertyNames: { pattern: "^[a-z]+$", ...extra },
      });

      expect(
        input(holding({}), holding({ description: "lower case" })),
      ).toEqual({ breaking: [], compatible: [] });
    });

    it("still reads past one inside a schema a map or a list holds", () => {
      const patterned = (extra: JSONSchema): JSONSchema => ({
        type: "object",
        patternProperties: { "^x-": { type: "string", ...extra } },
      });
      const listed = (extra: JSONSchema): JSONSchema => ({
        type: "array",
        prefixItems: [{ type: "string", ...extra }],
      });

      expect(
        input(patterned({}), patterned({ description: "a note" })),
      ).toEqual({ breaking: [], compatible: [] });
      expect(input(listed({}), listed({ title: "First" }))).toEqual({
        breaking: [],
        compatible: [],
      });
    });
  });

  describe("values listed two ways", () => {
    it("reads const and enum together, so neither hides the other", () => {
      expect(
        input({ const: "a" }, { const: "a", enum: ["b"] }).breaking,
      ).toEqual(['operations.op.input.enum: removed "a"']);
      expect(outcome({ const: "a", enum: ["a", "b"] }, { const: "a" })).toEqual(
        { breaking: [], compatible: [] },
      );
    });

    it("names the keyword the values are written with", () => {
      expect(input({ const: "a" }, { const: "b" }).breaking).toEqual([
        'operations.op.input.const: removed "a"',
      ]);
    });
  });

  describe("bounds as they are in effect", () => {
    it("reads a bound left out as what its keyword means by saying nothing", () => {
      // An array of any length already holds none or more, so writing that down changes nothing.
      expect(input({ type: "array" }, { type: "array", minItems: 0 })).toEqual({
        breaking: [],
        compatible: [],
      });
      expect(
        input({ type: "string", maxLength: 4 }, { type: "string" }).compatible,
      ).toEqual(["operations.op.input.maxLength: is no longer 4"]);
    });

    it("reads minContains left out as one, so removing a zero tightens", () => {
      // A validator refuses `minContains: 0` with no `maxContains` beside it, so both carry one.
      const counted = {
        type: "array",
        contains: { type: "string" },
        maxContains: 3,
      };

      expect(input({ ...counted, minContains: 0 }, counted).breaking).toEqual([
        "operations.op.input.minContains: is no longer 0",
      ]);
      expect(input(counted, { ...counted, minContains: 0 }).breaking).toEqual(
        [],
      );
    });

    it("reads a count bound with no contains to count as constraining nothing", () => {
      expect(
        input({ type: "array", minContains: 0 }, { type: "array" }),
      ).toEqual({ breaking: [], compatible: [] });
    });
  });

  describe("an outcome open to what it does not declare", () => {
    it("reads opening or closing one as changing nothing a caller was told", () => {
      // An outcome's data reaches the caller as it arrived, so a field beyond what is declared
      // is forwarded either way. What neither version did is declare it.
      const closed: JSONSchema = {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
      };
      const open: JSONSchema = { ...closed, additionalProperties: true };

      expect(outcome(closed, open)).toEqual({
        breaking: [],
        compatible: [
          "operations.op.outcomes.ok.additionalProperties: changed from false to true",
        ],
      });
      expect(outcome(open, closed).breaking).toEqual([]);
    });
  });
});

describe("checkVersions", () => {
  const version = (name: string, schemas: GatewaySchemas) => ({
    version: name,
    schemas,
  });

  it("accepts a history whose every step is safe", () => {
    expect(() =>
      checkVersions("test", [
        version("0001", asInput(person())),
        version("0002", asInput(person({ required: [] }))),
      ]),
    ).not.toThrow();
    expect(() =>
      checkVersions("test", [version("0001", asInput(person()))]),
    ).not.toThrow();
  });

  it("names every break and the versions it lies between", () => {
    const run = () =>
      checkVersions("test", [
        version("0001", asInput(person())),
        version("0002", asInput(person({ required: ["name", "age"] }))),
        version("0003", asInput(person({ required: ["name", "age"] }))),
        version("0004", asInput({ type: "string" })),
      ]);

    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SchemaCompatibilityError);
    expect((thrown as SchemaCompatibilityError).problems).toEqual([
      '0001 -> 0002: operations.op.input.required: "age" is now required',
      "0003 -> 0004: operations.op.input.type: changed from object to string",
      "0003 -> 0004: operations.op.input.properties.age: was removed",
      "0003 -> 0004: operations.op.input.properties.name: was removed",
    ]);
    expect((thrown as Error).message).toContain('Gateway "test"');
  });

  it("finds a break two versions added together would hide", () => {
    // The last step is safe; the one before it is not.
    expect(() =>
      checkVersions("test", [
        version("0001", asInput(person())),
        version("0002", asInput(person({ required: ["name", "age"] }))),
        version("0003", asInput(person({ required: ["name", "age"] }))),
      ]),
    ).toThrow(/0001 -> 0002/);
  });
});
