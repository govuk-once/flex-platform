// For something that loads what an address holds and then keeps it, as a JWKS cache keeps an
// issuer's keys: a function to call before each use, which loads the address again once the last
// load that worked is `maxAgeMs` old, and the first time it is asked. What is kept is then never
// older than that when used, so something the address stopped publishing stops being used.
//
// It fails as the load failed, and asks again the next time, so whatever needs what the address
// holds fails closed, never served from a copy past its age. The addresses are the caller's own,
// a fixed few, so the record of loads never grows.
export function keptFresh(
  load: (address: string) => Promise<unknown>,
  maxAgeMs: number,
): (address: string) => Promise<void> {
  const loadedAt = new Map<string, number>();
  return async (address) => {
    const loaded = loadedAt.get(address);
    if (loaded !== undefined && Date.now() - loaded < maxAgeMs) return;
    await load(address);
    loadedAt.set(address, Date.now());
  };
}
