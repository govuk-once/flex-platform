import type { JSONSchema } from "@repo/gateway-types";
import ajvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const Ajv2020 = ajvModule.default;
const addFormats = addFormatsModule.default;

// Whether a schema admits a value, worked out by the library, dialect and formats the generated
// validators are worked out by. A second reading of what a schema means is a second answer, and
// the one that decides what an upstream takes is not this repository's: `{ "type": "integer",
// "allOf": [{ "minimum": 10 }] }`, a `$ref` with keywords beside it, `false`, a list of types,
// `const` and `enum` together, and the length of a string counted in code points are each a rule
// someone would otherwise have had to read the same way twice.
//
// Strict mode is off, where generating validators has it on, because the schema here is an
// upstream's own: it is read to find out what it makes of one value, and refusing it for saying
// something ambiguous would say nothing about that value. Turning it off is not free of
// consequence for the value, though — it takes `strictNumbers` with it, and a number that JSON
// cannot write would then pass where a generated validator refuses it — so that one is asked
// for by name.
//
// Nothing is written anywhere. Ajv says what it could not apply through a logger, which is a
// terminal by default, and what it would say carries an upstream's own words: a format named in
// the document reaches the line as it was written. Those are collected and answered with, so
// they leave through the one boundary that makes text safe to print.
function reader(said: string[]): InstanceType<typeof Ajv2020> {
  const record = (...parts: unknown[]): void => {
    said.push(parts.map((part) => String(part)).join(" "));
  };
  const ajv = new Ajv2020({
    strict: false,
    strictNumbers: true,
    allErrors: true,
    // What the generated validators read, so this reads the same object they would: a field is
    // one the value holds, never one it inherits from `Object.prototype`.
    ownProperties: true,
    logger: { log: record, warn: record, error: record },
  });
  addFormats(ajv, { mode: "full" });
  return ajv;
}

// What a schema makes of a value. Refused and unchecked are kept apart because the two questions
// asked of them lean opposite ways: whether a value is one the schema admits is answered yes only
// where it was checked, and whether it is one the schema keeps out, only where it was refused.
export type ValueCheck =
  | { readonly verdict: "admitted" }
  // In the keywords' own words, which are written from the schema and never from the value.
  | { readonly verdict: "refused"; readonly problems: readonly string[] }
  // The schema says something that could not be applied, so what it makes of the value is not
  // known: what was left unapplied is what the upstream will hold the value to.
  | { readonly verdict: "unchecked"; readonly problems: readonly string[] };

// What a schema makes of a value. The document's shared schemas are put beside it so that a
// `#/components/schemas/Name` in it leads somewhere.
export function checkValue(
  schema: unknown,
  value: unknown,
  components: Readonly<Record<string, JSONSchema>> = {},
): ValueCheck {
  const rooted =
    typeof schema === "boolean"
      ? schema
      : { ...(schema as object), components: { schemas: components } };

  const said: string[] = [];
  let validate;
  try {
    validate = reader(said).compile(rooted as JSONSchema | boolean);
  } catch (cause) {
    return {
      verdict: "unchecked",
      problems: [
        `the schema cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    };
  }
  // Something the schema says was not applied, so what it says of the value is not the whole of
  // what the upstream will: a value that passed the rest has not been held to this.
  if (said.length > 0)
    return { verdict: "unchecked", problems: [...new Set(said)] };

  // An `$async` schema compiles to a validator that answers with a promise, and a promise read
  // as an answer is one that passed: the value would be derived as admitted, and the rejection
  // would come back with nothing waiting for it. Generation refuses such a schema where it
  // meets one, but a value a path fixes has left the input before any generated validator runs,
  // so the refusal has to be here as well. Ajv marks the validator rather than the schema, and
  // only that overload declares the property.
  if ("$async" in validate) {
    return {
      verdict: "unchecked",
      problems: [
        '"$async" is not supported, because validation is synchronous',
      ],
    };
  }

  if (validate(value)) return { verdict: "admitted" };
  return {
    verdict: "refused",
    problems: (validate.errors ?? []).map(
      (error) => error.message ?? "it is not one the schema admits",
    ),
  };
}
