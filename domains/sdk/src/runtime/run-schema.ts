// A route's schemas are the domain's code, run by the SDK. A refinement or transform may be async,
// so every schema runs with `safeParseAsync`. One that throws has failed, which is told apart from
// a value it refuses: a refusal is the request's mistake, or the handler's, and a failure is the
// schema's.

import type { ZodType } from "zod";

export type SchemaResult =
  | { readonly kind: "accepted"; readonly data: unknown }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly error: unknown };

export async function runSchema(
  schema: ZodType,
  value: unknown,
): Promise<SchemaResult> {
  try {
    const parsed = await schema.safeParseAsync(value);

    return parsed.success
      ? { kind: "accepted", data: parsed.data }
      : { kind: "refused" };
  } catch (error: unknown) {
    return { kind: "failed", error };
  }
}
