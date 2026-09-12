import type { SecureValue } from "@repo/gateway-types";

import { GatewayError } from "./errors.ts";
import { compilePaths, valueAt } from "./field-path.ts";

export function prepareSecurePayload(
  values: Readonly<Record<string, SecureValue>>,
): string {
  const sorted: Record<string, SecureValue> = {};
  const keys = Object.keys(values).sort();
  for (const key of keys) {
    const value = values[key];
    if (value !== undefined) sorted[key] = value;
  }
  return JSON.stringify(sorted);
}

export interface CompiledBinding {
  readonly inputPath: string;
  readonly segments: readonly string[];
  readonly secureKey: string;
}

export function compileBindings(
  secure: Readonly<Record<string, string>> | undefined,
): CompiledBinding[] {
  if (!secure) return [];

  return Object.entries(secure).map(([inputPath, secureKey]) => {
    const [compiled] = compilePaths([inputPath]);
    if (!compiled) {
      throw new TypeError(
        `Invalid secure binding path: ${JSON.stringify(inputPath)}`,
      );
    }
    // A wildcard would bind many input values to one secure value, which has no meaning.
    if (compiled.wildcard) {
      throw new TypeError(
        `Secure binding path must not contain a wildcard: ${JSON.stringify(inputPath)}`,
      );
    }
    if (typeof secureKey !== "string" || secureKey.length === 0) {
      throw new TypeError(
        `Secure binding for "${inputPath}" must name a non-empty secure value key`,
      );
    }
    return { inputPath, segments: compiled.segments, secureKey };
  });
}

// Reject absent or unequal bound values. Diagnostics name paths and keys only, never values.
export function checkSecureBindings(
  bindings: readonly CompiledBinding[],
  input: unknown,
  values: Readonly<Record<string, SecureValue>>,
  _signature: string,
): void {
  // The signature is not verified, so these comparisons establish consistency, not
  // authenticity. The canonical payload is still built on every request to keep that path
  // exercised; its result is unused until verification exists.
  prepareSecurePayload(values);

  for (const binding of bindings) {
    if (!Object.hasOwn(values, binding.secureKey)) {
      throw new GatewayError(
        "SECURE_VALUE_MISMATCH",
        `Secure value "${binding.secureKey}" is missing from the envelope`,
      );
    }

    const actual = valueAt(input, binding.segments);
    if (actual === undefined) {
      throw new GatewayError(
        "SECURE_VALUE_MISMATCH",
        `Input "${binding.inputPath}" is bound to secure value "${binding.secureKey}" but is absent`,
      );
    }

    const expected: SecureValue | undefined = values[binding.secureKey];
    if (actual !== expected) {
      throw new GatewayError(
        "SECURE_VALUE_MISMATCH",
        `Input "${binding.inputPath}" does not match secure value "${binding.secureKey}"`,
      );
    }
  }
}
