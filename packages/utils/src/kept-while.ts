// For a value that is loaded and then kept, as a secret a function reads once, or credentials it
// holds until they near their expiry: a function to call for the value, which returns what it
// holds while `isCurrent` says so, and otherwise loads it, keeps it and returns it.
//
// The load runs once for callers that ask while it is under way: each waits for the same load.
// It is given what is held, or `undefined` the first time, so it can reuse part of it, or return
// it again when it can load nothing newer.
//
// A load that fails leaves what is held as it was, and fails the callers that were waiting for
// it and no caller after them: the next one loads again. So a failure is never kept.
export function keptWhile<Held>(
  load: (held: Held | undefined) => Promise<Held>,
  isCurrent: (held: Held) => boolean,
): () => Promise<Held> {
  // Wrapped, so a value that is itself `undefined` still counts as held.
  let held: { readonly value: Held } | undefined;
  let underWay: Promise<Held> | undefined;

  async function loaded(): Promise<Held> {
    const value = await load(held?.value);
    held = { value };
    return value;
  }

  return () => {
    if (held !== undefined && isCurrent(held.value)) {
      return Promise.resolve(held.value);
    }
    underWay ??= loaded().finally(() => {
      underWay = undefined;
    });
    return underWay;
  };
}
