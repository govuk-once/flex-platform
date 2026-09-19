// Whether a value is a plain object: something whose properties can be read by name. Arrays are
// objects to `typeof` and null is too, and neither is what a caller reaching for a field wants.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
