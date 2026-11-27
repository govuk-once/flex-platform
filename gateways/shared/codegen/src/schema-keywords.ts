// Where a JSON Schema holds other schemas, read the same way wherever a schema is walked: under a
// name of its own, in a list, or on its own. Comparing versions and deriving them both walk every
// one of these, so a keyword one of them missed would go unchecked.

export const SUBSCHEMA_MAPS: ReadonlySet<string> = new Set([
  "$defs",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

/**
 * Lists whose branches are read as a set: every one holds, one at least does, or exactly one
 * does, none of which depends on where a branch is written.
 */
export const COMPOSITION: ReadonlySet<string> = new Set([
  "allOf",
  "anyOf",
  "oneOf",
]);

/** `prefixItems` types the element at each place, so its order is what it says. */
export const SUBSCHEMA_LISTS: ReadonlySet<string> = new Set([
  ...COMPOSITION,
  "prefixItems",
]);

export const SUBSCHEMAS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * The bounds that count matches rather than measure a value. With no `contains` to count they
 * constrain nothing.
 */
export const CONTAINS_BOUNDS: ReadonlySet<string> = new Set([
  "maxContains",
  "minContains",
]);
