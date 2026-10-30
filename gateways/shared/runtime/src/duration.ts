const MULTIPLIERS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
} as const;

// The pattern names every unit MULTIPLIERS holds, and no other.
const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m)$/;

export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value);
  if (!match) {
    throw new TypeError(`Invalid duration: ${JSON.stringify(value)}`);
  }

  const [, rawAmount, unit] = match as RegExpExecArray &
    [string, string, keyof typeof MULTIPLIERS];
  return Number(rawAmount) * MULTIPLIERS[unit];
}
