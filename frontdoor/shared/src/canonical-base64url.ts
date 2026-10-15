const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

// Whether a JWT segment is unpadded base64url with its spare bits zero, as every encoder writes it.
// A decoder ignores those bits, so an RS256 signature could be written 16 ways that all verify,
// and WAF would count each as a different token.
export function isCanonicalBase64url(segment: string): boolean {
  if (!BASE64URL.test(segment)) return false;
  // Six bits a character: a final group of 2 leaves 4 bits spare, of 3 leaves 2, and of 1 can't
  // hold a byte.
  const remainder = segment.length % 4;
  if (remainder === 0) return true;
  if (remainder === 1) return false;
  const spare = remainder === 2 ? 15 : 3;
  return (ALPHABET.indexOf(segment.charAt(segment.length - 1)) & spare) === 0;
}
