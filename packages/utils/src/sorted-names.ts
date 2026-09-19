import { byCodeUnit } from "./internal/by-code-unit.ts";

// The names in the one order everything reproducible uses. Takes anything iterable and answers
// with an array of its own, so a caller's collection is left as it was.
export function sortedNames(names: Iterable<string>): string[] {
  return [...names].sort(byCodeUnit);
}
