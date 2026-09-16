// The gateway secret as the runtime hands it to a driver, as types only. The runtime retrieves
// and caches it; a driver validates it. Neither side needs the other's package to name these.

// The parsed secret: a JSON object. Its fields are untrusted until a driver's validator has
// accepted them, so nothing here says what they are.
export type SecretObject = Readonly<Record<string, unknown>>;

// Resolves the current secret. A retrieved copy is served for a bounded age, after which the
// next call retrieves it again. A driver wraps the provider so that every value it hands to
// authentication code has passed the driver's validator.
export interface SecretProvider<T = SecretObject> {
  get(): Promise<T>;
}
