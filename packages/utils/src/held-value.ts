// The value a map holds under a key the caller built it to hold. A missing key is a bug in the
// caller, so it throws instead of answering with undefined for the caller to assert away.
export function heldValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  if (!map.has(key)) throw new Error(`Nothing is held under ${String(key)}`);
  return map.get(key) as V;
}
