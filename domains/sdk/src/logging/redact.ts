// Redaction by pattern, over every log line's fields and message. Ported from the previous
// platform's sanitiser: a field whose name looks like a secret or like personal data is replaced
// whole, and a string value that looks like one is replaced too. The previous environment switch,
// which let personal data through outside production, is not carried over: nothing here branches
// on where it runs. A domain adds its own patterns through its configuration's logging block.

import { isSummary, summarise } from "./summarise.ts";

export const REDACTED = "[redacted]";

// Written for a value that holds itself, as pino's own serialiser writes it, and for one nested
// deeper than anything a log line should hold.
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";
const MAX_DEPTH = 32;

const SECRET_KEYS: readonly RegExp[] = [
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /api.?key/i,
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

// A key is tested as written and as words (see `words`), so `\b` finds a short name such as
// `dob` inside `applicantDob` without finding it inside a longer word.
const PERSONAL_KEYS: readonly RegExp[] = [
  /email/i,
  /phone/i,
  /\bmobile\b/i,
  /mobile.?number/i,
  /forename/i,
  /surname/i,
  /first.?name/i,
  /last.?name/i,
  /full.?name/i,
  /date.?of.?birth/i,
  /\bdob\b/i,
  /\bnino\b/i,
  /national.?insurance/i,
  /post.?code/i,
  /zip.?code/i,
  /sort.?code/i,
  /account.?number/i,
  /\bip.?address\b/i,
];

// A field's name as words: `bankAccountNumber`, `bank_account_number` and `IPAddress` are each
// split where a reader would split them.
function words(key: string): string {
  return key
    .replaceAll(/([a-z\d])(?=[A-Z])/g, "$1 ")
    .replaceAll(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .replaceAll(/[_\-.\s]+/g, " ");
}

const SECRET_VALUES: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, // a JWT, anywhere in the value
];

const PERSONAL_VALUES: readonly RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/, // an email address
  /(?:\+44|0)\d{9,10}/, // a UK phone number
  /(?:\+44 ?|(?<!\d)0)(?:\d ?){8,9}\d/, // and one written in groups, such as 07700 900123
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

function isCardNumber(digits: string): boolean {
  return (
    digits.length >= 13 &&
    digits.length <= 19 &&
    CARD_PREFIXES.some((prefix) => prefix.test(digits)) &&
    passesLuhn(digits)
  );
}

// A card number is written whole or in groups, and a run of digits and separators can hold more
// than the number: a date or a reference before it, say. So every stretch of whole groups is
// tried, not only the run as one number.
function holdsCardNumber(value: string): boolean {
  for (const [run] of value.matchAll(/\d(?:[ -]?\d)+/g)) {
    const groups = run.split(/[ -]/);
    for (let first = 0; first < groups.length; first += 1) {
      let digits = "";
      for (
        let last = first;
        last < groups.length && digits.length < 19;
        last += 1
      ) {
        digits += groups[last] ?? "";
        if (isCardNumber(digits)) return true;
      }
    }
  }
  return false;
}

// A pattern with the `g` or `y` flag remembers where its last match ended and `test` starts from
// there, so it answers differently on alternate calls. Each test starts from the beginning.
function matches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
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
  /**
   * A copy of the value as JSON would write it, with every sensitive field and string replaced
   * at any depth, and every error reduced to where it was created.
   */
  redact(value: unknown): unknown;
}

export function createRedactor(options: RedactionOptions = {}): Redactor {
  // The domain's patterns are copied, so resetting where a test starts never touches its own.
  const copy = (pattern: RegExp) => new RegExp(pattern);
  const keys = [
    ...SECRET_KEYS,
    ...PERSONAL_KEYS,
    ...(options.redactKeys ?? []).map(copy),
  ];
  const values = [
    ...SECRET_VALUES,
    ...PERSONAL_VALUES,
    ...(options.redactValues ?? []).map(copy),
  ];

  const redactsKey = (key: string) => {
    const asWords = words(key);
    return keys.some(
      (pattern) => matches(pattern, key) || matches(pattern, asWords),
    );
  };

  const redactString = (value: string) =>
    holdsCardNumber(value) || values.some((pattern) => matches(pattern, value))
      ? REDACTED
      : value;

  // What JSON would write for an object, redacted: an array's items, the result of `toJSON`, or
  // the object's own enumerable fields, whatever its class or prototype.
  const redactObject = (value: object, ancestors: Set<object>): unknown => {
    if (Array.isArray(value)) {
      return value.map((item: unknown) => walk(item, ancestors));
    }
    const { toJSON } = value as { toJSON?: unknown };
    if (typeof toJSON === "function") {
      return walk(toJSON.call(value), ancestors);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [
        key,
        redactsKey(key) ? REDACTED : walk(item, ancestors),
      ]),
    );
  };

  const walk = (value: unknown, ancestors: Set<object>): unknown => {
    if (typeof value === "string") return redactString(value);
    if (typeof value !== "object" || value === null) return value;
    if (isSummary(value)) return value;
    if (Error.isError(value)) return summarise(value);
    if (ancestors.has(value)) return CIRCULAR;
    if (ancestors.size >= MAX_DEPTH) return TRUNCATED;
    ancestors.add(value);
    try {
      return redactObject(value, ancestors);
    } catch {
      // A getter or a `toJSON` that throws: nothing of the value can be shown to be safe.
      return REDACTED;
    } finally {
      ancestors.delete(value);
    }
  };

  return {
    redactsKey,
    redactString,
    redact: (value) => walk(value, new Set()),
  };
}
