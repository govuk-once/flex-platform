import { sortedNames } from "./sorted-names.ts";

// A record's own entries, by key, in the one order everything reproducible uses. What a record
// is iterated for is usually written out afterwards, and insertion order is not something the
// writer of a configuration or a schema should have to think about.
export function sortedEntries<T>(
  record: Readonly<Record<string, T>>,
): [string, T][] {
  return sortedNames(Object.keys(record)).map((key) => [key, record[key] as T]);
}
