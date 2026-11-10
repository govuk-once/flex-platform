// Redaction by pattern, over every log line's fields and message. Ported from the previous
// platform's sanitiser: a field whose name looks like a secret or like personal data is replaced
// whole, and a string value that looks like one is replaced too. The previous environment switch,
// which let personal data through outside production, is not carried over: nothing here branches
// on where it runs. A domain adds its own patterns through its configuration's logging block.

export const REDACTED = "[redacted]";

const SECRET_KEYS: readonly RegExp[] = [
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /apikey/i,
  /api_key/i,
  /credential/i,
  /private.?key/i,
  /access.?key/i,
  /client.?secret/i,
  /signing/i,
  /card.?number/i,
  /\bpan\b/i,
  /\bcvv2?\b/i,
  /\bcvc2?\b/i,
  /\bcsc\b/i,
  /card.?security.?code/i,
  /card.?verification/i,
  /card.?expir/i,
];

const PERSONAL_KEYS: readonly RegExp[] = [
  /\bemail\b/i,
  /\bphone\b/i,
  /\bmobile\b/i,
  /\bforename\b/i,
  /\bsurname\b/i,
  /\bfirst.?name\b/i,
  /\blast.?name\b/i,
  /\bfull.?name\b/i,
  /\bdate.?of.?birth\b/i,
  /\bdob\b/i,
  /\bnino\b/i,
  /\bnational.?insurance\b/i,
  /\bpostcode\b/i,
  /\bzip.?code\b/i,
  /\bsort.?code\b/i,
  /\baccount.?number\b/i,
  /\bip.?address\b/i,
];

const SECRET_VALUES: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, // a JWT, anywhere in the value
];

const PERSONAL_VALUES: readonly RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/, // an email address
  /(?:\+44|0)\d{9,10}/, // a UK phone number
  /\b[A-Z]{2}\d{6}[A-D]\b/, // a National Insurance number
  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, // a UK postcode
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, // an IPv4 address
];

// Card number prefixes of the major schemes, checked before Luhn so a long id is less often
// taken for a card.
const CARD_PREFIXES: readonly RegExp[] = [
  /^4/,
  /^5[1-5]/,
  /^2(?:2[2-9]|[3-6]\d|7[01]|720)/,
  /^3[47]/,
  /^6(?:011|5|4[4-9]|22)/,
  /^3(?:0[0-5]|[689])/,
  /^35(?:2[89]|[3-8]\d)/,
];

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function holdsCardNumber(value: string): boolean {
  const candidates = value.match(/\d(?:[ -]?\d){12,18}/g);
  if (candidates === null) return false;
  return candidates
    .map((candidate) => candidate.replaceAll(/[ -]/g, ""))
    .filter((digits) => digits.length >= 13 && digits.length <= 19)
    .some(
      (digits) =>
        CARD_PREFIXES.some((prefix) => prefix.test(digits)) &&
        passesLuhn(digits),
    );
}

export interface RedactionOptions {
  /** Field names to redact, beyond the platform's. */
  readonly redactKeys?: readonly RegExp[];
  /** Values to redact, beyond the platform's. */
  readonly redactValues?: readonly RegExp[];
}

export interface Redactor {
  /** Whether a field with this name is replaced whole. */
  redactsKey(key: string): boolean;
  /** The string with anything that looks sensitive replaced. */
  redactString(value: string): string;
  /** A copy of the value with every sensitive field and string replaced, at any depth. */
  redact(value: unknown): unknown;
}

export function createRedactor(options: RedactionOptions = {}): Redactor {
  const keys = [
    ...SECRET_KEYS,
    ...PERSONAL_KEYS,
    ...(options.redactKeys ?? []),
  ];
  const values = [
    ...SECRET_VALUES,
    ...PERSONAL_VALUES,
    ...(options.redactValues ?? []),
  ];

  const redactsKey = (key: string) => keys.some((pattern) => pattern.test(key));

  const redactString = (value: string) =>
    holdsCardNumber(value) || values.some((pattern) => pattern.test(value))
      ? REDACTED
      : value;

  // Walks plain data only. A class instance, an error among them, is logged as whatever pino's
  // serialisers made of it before this runs, so it is passed through by reference.
  const redact = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") return redactString(value);
    if (depth > 32 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redact(item, depth + 1));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactsKey(key) ? REDACTED : redact(item, depth + 1);
    }
    return result;
  };

  return { redactsKey, redactString, redact };
}
