import { GatewayError } from "@repo/gateway-runtime";
import type {
  SecretObject,
  SecretProvider,
  Validator,
} from "@repo/gateway-types";

const MAX_FINDINGS = 5;

// Where the secret failed, as the schema locations that rejected it. Never a value, never a
// validator's message, which a custom validator may have built from one, and never a path into
// the secret: under a dictionary schema its segments are the secret's own keys.
export function describeSecretFindings(errors: Validator["errors"]): string {
  if (!errors || errors.length === 0) return "did not match the expected shape";
  const findings = errors.slice(0, MAX_FINDINGS).map((e) => e.schemaPath);
  return `failed validation at ${findings.join(", ")}`;
}

// Runs the driver's validator on every read. A read is cheap, since the runtime serves the
// secret from its cache, and validating each one means a rotated value is checked the first
// time it is seen. A value that passes reaches authentication code as its typed value; one that
// fails is never returned, and the affected operation fails instead.
export function validatedSecret<T>(
  gatewayId: string,
  provider: SecretProvider,
  validate: Validator<T>,
): SecretProvider<T> {
  return {
    async get() {
      let value: SecretObject;
      try {
        value = await provider.get();
      } catch (err: unknown) {
        // The runtime's provider raises GatewayErrors; any other provider's error is unknown.
        if (err instanceof GatewayError) throw err;
        throw new GatewayError(
          "INTERNAL",
          `Gateway "${gatewayId}" secret retrieval failed`,
        );
      }
      let valid: boolean;
      try {
        valid = validate(value);
      } catch {
        // A validator that throws has said nothing safe about the secret either.
        throw new GatewayError(
          "INTERNAL",
          `Gateway "${gatewayId}" secret validator threw`,
        );
      }
      if (!valid) {
        throw new GatewayError(
          "INTERNAL",
          `Gateway "${gatewayId}" secret ${describeSecretFindings(validate.errors)}`,
        );
      }
      return value as T;
    },
  };
}
