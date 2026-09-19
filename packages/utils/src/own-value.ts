// A record's own value under a key, with an inherited member read as absent. Reaching for a key
// a caller supplied is how `constructor` or `toString` arrives as a value that was never stored:
// a lookup by name answers with whatever the prototype holds unless it is asked this way.
export function ownValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
