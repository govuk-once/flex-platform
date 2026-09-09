const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m)$/;

const MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
};

export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value);
  if (!match) {
    throw new TypeError(`Invalid duration: ${JSON.stringify(value)}`);
  }

  const [, rawAmount, unit] = match as RegExpExecArray &
    [string, string, string];
  const multiplier = MULTIPLIERS[unit];
  if (multiplier === undefined) {
    throw new TypeError(`Unknown duration unit: ${unit}`);
  }

  return Number(rawAmount) * multiplier;
}
