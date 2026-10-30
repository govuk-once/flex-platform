import { stringsIn } from "./strings-in.ts";

// The strings in a value that may be one string or an array of them, such as JSON Schema's `type`.
// A string is a list of one, and an array gives the strings in it, as `stringsIn` does. Anything
// else is neither and gives `undefined`, so a caller can tell a value left out from an empty list.
export function oneOrMoreStrings(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return stringsIn(value);
  if (typeof value === "string") return [value];
  return undefined;
}
