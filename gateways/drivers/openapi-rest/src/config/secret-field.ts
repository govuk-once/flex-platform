// A value the gateway's secret holds, named by the field it is kept under. Nothing is read from
// a secret unless the configuration names the field, and no field has a default: a secret may be
// the gateway's own or one an upstream provides in a shape of its own, and only the
// configuration says which of its fields mean what.
export interface SecretField {
  readonly secretField: string;
  // Present in some secrets and not others, an external ID say. A field not marked optional
  // must be there, or the secret is refused.
  readonly optional: boolean;
}

export function fromSecret(
  field: string,
  options: { readonly optional?: boolean } = {},
): SecretField {
  if (typeof field !== "string" || field.trim() !== field || field === "") {
    throw new TypeError(
      "fromSecret: a field is named by a non-empty string with no surrounding space",
    );
  }
  return Object.freeze({
    secretField: field,
    optional: options.optional === true,
  });
}

export function isSecretField(value: unknown): value is SecretField {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<SecretField>).secretField === "string" &&
    typeof (value as Partial<SecretField>).optional === "boolean"
  );
}

// A setting written in the configuration, or read from the secret. Credentials take only a
// SecretField, so none can be written into a configuration.
export type Setting = string | SecretField;

// The fields a gateway named, read from one retrieval of its secret. Only named fields are here;
// the rest of the secret is never read. Every value has passed the checks a field is held to.
export interface SecretValues {
  get(field: SecretField): string | undefined;
}
