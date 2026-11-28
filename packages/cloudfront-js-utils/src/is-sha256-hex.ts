const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether text is a SHA-256 as SigV4 and the platform write one: 64 hex digits, in lowercase. */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}
