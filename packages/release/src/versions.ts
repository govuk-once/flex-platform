// Versions as the record holds them: major.minor.patch, with no prerelease or build. A release
// candidate's suffix is only added as a candidate is packed, so nothing else ever reads one.

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export type Bump = "major" | "minor" | "patch";

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(text: string): Version {
  const match = RELEASE_VERSION.exec(text);
  if (match === null) {
    throw new Error(`${JSON.stringify(text)} is not a release version.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatVersion({ major, minor, patch }: Version): string {
  return `${major}.${minor}.${patch}`;
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

export function bumped(version: string, bump: Bump): string {
  const { major, minor, patch } = parseVersion(version);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// A derived package's build writes its major and minor, at patch 0, and the release sets the
// patch. A build ahead of the last release is a new minor or major, so it is released as built.
export function nextDerivedVersion(
  built: string,
  released: string | undefined,
): string {
  const b = parseVersion(built);
  if (b.patch !== 0) {
    throw new Error(
      `The build wrote ${built}, but a derived package is built at patch 0.`,
    );
  }
  if (released === undefined) return built;
  const r = parseVersion(released);
  const order = b.major - r.major || b.minor - r.minor;
  if (order > 0) return built;
  if (order === 0) return formatVersion({ ...r, patch: r.patch + 1 });
  throw new Error(
    `The build wrote ${built}, behind ${released}, its last release.`,
  );
}

export function candidateVersion(version: string, candidate: number): string {
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error(`${candidate} is not a candidate number.`);
  }
  return `${formatVersion(parseVersion(version))}-rc.${candidate}`;
}

// A pull request title, as `FLEX-<number> <type>(<scope>)?!?: <description>`, which is also each
// commit's subject. Anything else, such as a merge commit, says nothing about the bump.
const TITLE = /^FLEX-\d+ ([a-z]+)(?:\([^)]*\))?!?: /;

// The bump the titles of a package's changes suggest: a feature is a minor, and anything else a
// patch. A change that breaks a caller is never suggested: a person chooses a major.
export function suggestedBump(titles: readonly string[]): Bump {
  return titles.some((title) => TITLE.exec(title)?.[1] === "feat")
    ? "minor"
    : "patch";
}
