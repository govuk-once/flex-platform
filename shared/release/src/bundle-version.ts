// A bundle's version: the version of a domain's code, as its pipeline names it. It is
// `MAJOR.MINOR.PATCH`, as semantic versioning writes one, and nothing more: no `v`, no
// pre-release and no build metadata, so versions compare by their numbers alone. Pre-releases
// would need semantic versioning's full precedence rules.
//
// Each part is at most nine digits, so it is a safe integer, and has no leading zero, so a version
// is written one way.

const BUNDLE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export function isBundleVersion(value: string): boolean {
  return BUNDLE_VERSION.test(value);
}

/**
 * Below zero when `a` is the earlier version, above it when `a` is the later, and zero when they
 * are the same. Throws for a value that isn't a version.
 */
export function compareBundleVersions(a: string, b: string): number {
  const left = partsOf(a);
  const right = partsOf(b);
  for (const [index, part] of left.entries()) {
    const difference = part - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// By number, not as text, so 1.10.0 comes after 1.9.0.
function partsOf(version: string): readonly number[] {
  const match = BUNDLE_VERSION.exec(version);
  if (match === null) {
    throw new TypeError("The value isn't a bundle's version");
  }
  return match.slice(1).map(Number);
}
