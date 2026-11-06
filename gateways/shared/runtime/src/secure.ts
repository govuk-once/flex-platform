import {
  SECURE_CLAIMS,
  type SecureClaim,
  type SecureClaims,
} from "@repo/gateway-core";

import { GatewayError } from "./errors.ts";
import { compilePath, valueAt } from "./field-path.ts";

export interface CompiledBinding {
  readonly inputPath: string;
  readonly segments: readonly string[];
  readonly claim: SecureClaim;
}

const CLAIMS: ReadonlySet<string> = new Set(SECURE_CLAIMS);

export function compileBindings(
  secure: Readonly<Record<string, string>> | undefined,
): CompiledBinding[] {
  if (!secure) return [];

  return Object.entries(secure).map(([inputPath, claim]) => {
    const compiled = compilePath(inputPath);
    // A wildcard would bind many input values to one claim, which has no meaning.
    if (compiled.wildcard) {
      throw new TypeError(
        `Secure binding path must not contain a wildcard: ${JSON.stringify(inputPath)}`,
      );
    }
    // The configuration's type holds it to a claim too, but a configuration written as plain
    // JavaScript, or cast, would otherwise bind to a value no token carries.
    if (!CLAIMS.has(claim)) {
      throw new TypeError(
        `Secure binding for "${inputPath}" must name a caller token claim: ${SECURE_CLAIMS.join(", ")}`,
      );
    }
    return {
      inputPath,
      segments: compiled.segments,
      claim: claim as SecureClaim,
    };
  });
}

// Refuse an absent or unequal bound value. The claims come from a verified caller token.
// Diagnostics name paths and claims only, never values.
export function checkSecureBindings(
  bindings: readonly CompiledBinding[],
  input: unknown,
  claims: SecureClaims,
): void {
  for (const binding of bindings) {
    const actual = valueAt(input, binding.segments);
    if (actual === undefined) {
      throw new GatewayError(
        "SECURE_VALUE_MISMATCH",
        `Input "${binding.inputPath}" is bound to claim "${binding.claim}" but is absent`,
      );
    }
    if (actual !== claims[binding.claim]) {
      throw new GatewayError(
        "SECURE_VALUE_MISMATCH",
        `Input "${binding.inputPath}" does not match claim "${binding.claim}"`,
      );
    }
  }
}
