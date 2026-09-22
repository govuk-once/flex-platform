// The strings in a value that should be an array of them. Anything else — a value that is not an
// array, or an element that is not a string — contributes nothing rather than failing: a caller
// reading a declaration it did not write is better served by what it can use than by a throw.
export function stringsIn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
