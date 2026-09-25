import { GatewayError } from "@repo/gateway-runtime";
import type { SecretProvider } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";

import type { SecretField, SecretValues } from "../config/secret-field.ts";
import { isVerbatimHeaderValue } from "../headers.ts";

// What a named field fails on. Every value read here may be sent as written, in a header or as
// an address or a credential, so each is a non-empty string a header can carry unchanged.
function fieldProblem(
  secret: Readonly<Record<string, unknown>>,
  { secretField, optional }: SecretField,
): string | undefined {
  if (!Object.hasOwn(secret, secretField)) {
    return optional ? undefined : `field "${secretField}" is missing`;
  }
  const value = secret[secretField];
  if (typeof value !== "string" || value === "") {
    return `field "${secretField}" is not a non-empty string`;
  }
  if (!isVerbatimHeaderValue(value)) {
    return `field "${secretField}" holds a character or a surrounding space it cannot be sent with`;
  }
  return undefined;
}

// The fields a gateway names, read from its secret on every read. A read is cheap, since the
// runtime serves the secret from its cache, and reading each time means a rotated value is
// checked the first time it is seen. Fields nobody named are never read, so a secret an upstream
// provides may hold whatever else it likes. A field that fails is never returned, and the
// affected operation fails instead. Diagnostics name the field, which is the configuration's,
// and the rule; never a value, and never a field the configuration did not name.
export function secretFields(
  gatewayId: string,
  provider: SecretProvider,
  fields: readonly SecretField[],
): { get(): Promise<SecretValues> } {
  return {
    async get() {
      let secret: unknown;
      try {
        secret = await provider.get();
      } catch (err: unknown) {
        // The runtime's provider raises GatewayErrors; any other provider's error is unknown.
        if (err instanceof GatewayError) throw err;
        throw new GatewayError(
          "INTERNAL",
          `Gateway "${gatewayId}" secret retrieval failed`,
        );
      }
      if (!isRecord(secret)) {
        throw new GatewayError(
          "INTERNAL",
          `Gateway "${gatewayId}" secret is not an object`,
        );
      }
      const problems = [
        ...new Set(
          fields.flatMap((field) => fieldProblem(secret, field) ?? []),
        ),
      ];
      if (problems.length > 0) {
        throw new GatewayError(
          "INTERNAL",
          `Gateway "${gatewayId}" secret ${problems.join("; ")}`,
        );
      }
      const values = new Map<string, string>();
      for (const { secretField } of fields) {
        const value = secret[secretField];
        if (Object.hasOwn(secret, secretField) && typeof value === "string") {
          values.set(secretField, value);
        }
      }
      return { get: (field) => values.get(field.secretField) };
    },
  };
}
