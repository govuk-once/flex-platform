import type { FieldValue } from "./event.ts";

// A repeated header keeps only its first value in `value`. A function reads that, but a later
// step might read another, so every header a function reads must have one value.
export function isRepeated(field: FieldValue | undefined): boolean {
  return field?.multiValue !== undefined && field.multiValue.length > 1;
}
