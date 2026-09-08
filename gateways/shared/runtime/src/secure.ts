export function prepareSecurePayload(values: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(values).sort();
  for (const key of keys) {
    sorted[key] = values[key];
  }
  return JSON.stringify(sorted);
}

export function checkSecureBindings(
  values: Record<string, unknown>,
  _signature: string,
): void {
  prepareSecurePayload(values);
  // Signature verification deferred — jose lands later.
}
