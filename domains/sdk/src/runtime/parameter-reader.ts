// Reads a route's path or query parameters from their text into the values their schema declares,
// before the schema validates them. Created once per route, from the types checkDomain has
// already accepted.
//
// Each value is read strictly: only text written the one way its type is written is converted,
// and anything else stays text, for the schema to refuse. JavaScript's own conversions are loose:
// `Number("")` is 0, `Number("1e3")` is 1000, and every text but "" is true.
//
// A query parameter sent once arrives as a string, and sent more than once as a list of them. A
// field declared as an array takes either as a list. Any other field takes one value, and a list
// is left as it is, for its schema to refuse. A parameter the schema does not declare is passed on
// as it arrived, for the schema to refuse too.

import type { ParameterType, ScalarType } from "../input-rules.ts";

export type SentParameters = ReadonlyMap<string, string | readonly string[]>;

// A value read by its declared type, or left as text for the schema to refuse.
type ReadValue = string | number | boolean;

/** Each parameter by name, as the route's schema validates it. */
export type ReadParameters = Readonly<
  Record<string, ReadValue | readonly ReadValue[]>
>;

// A plain decimal: no sign but "-", no leading zero, no exponent, no hexadecimal, no space.
const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

const BOOLEANS: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["false", false],
]);

// A whole number past 2^53 has no exact double, so reading it would round it to a neighbour that
// still validates; it stays text, as the openapi-rest driver reads a header. So does "-0", which
// would reach a handler as a negative zero, and so do enough digits to overflow to Infinity.
function numberFromText(text: string): number | string {
  if (!DECIMAL.test(text) || text === "-0") return text;

  const number = Number(text);

  if (!Number.isFinite(number)) return text;

  return Number.isInteger(number) && !Number.isSafeInteger(number)
    ? text
    : number;
}

function scalarFromText(scalar: ScalarType, text: string): ReadValue {
  if (scalar === "boolean") return BOOLEANS.get(text) ?? text;

  return scalar === "number" ? numberFromText(text) : text;
}

function readParameter(
  { scalar, isArray }: ParameterType,
  sent: string | readonly string[],
): ReadValue | readonly ReadValue[] {
  if (typeof sent === "string") {
    const value = scalarFromText(scalar, sent);

    return isArray ? [value] : value;
  }

  return isArray ? sent.map((item) => scalarFromText(scalar, item)) : sent;
}

/** Reads the parameters a request sent by the types their fields declare. */
export function createParameterReader(
  types: ReadonlyMap<string, ParameterType>,
): (sent: SentParameters) => ReadParameters {
  return (sent) => {
    // Without a prototype, so the schema finds a field it declares only where the request set it,
    // never one such as `toString` that every object inherits.
    const values: Record<string, ReadValue | readonly ReadValue[]> = {};

    Object.setPrototypeOf(values, null);

    for (const [name, value] of sent) {
      const type = types.get(name);

      values[name] = type === undefined ? value : readParameter(type, value);
    }

    return values;
  };
}
