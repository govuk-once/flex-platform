// A UUID of version 7 (RFC 9562), whose first 48 bits are the time it was made, in milliseconds.
// So UUIDs made at different times sort as text in the order they were made. Node has no
// generator for them. The caller passes the time and the random bytes, so a test can fix both.

/** A UUID of version 7 made at `now`, in milliseconds since the epoch, from ten random bytes. */
export function uuidV7(now: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError("A UUID's time must fit in 48 bits");
  }
  if (random.length !== 10) {
    throw new RangeError("A UUID takes ten random bytes");
  }
  const bytes = new Uint8Array(16);
  // 2^48 overflows a 32-bit shift, so the time is split into its high 16 and low 32 bits.
  const high = Math.floor(now / 2 ** 32);
  const low = now % 2 ** 32;
  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;
  bytes.set(random, 6);
  // The version, 7, and the variant, 10 in binary, over the random bits there.
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
