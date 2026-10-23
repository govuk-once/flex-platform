// Where the packages this repository publishes come from, and how each kind is versioned.

export interface Source {
  /** What the packages are listed under when choosing a release. */
  readonly group: string;
  /** Workspace package directories, from the workspace root, as globs. */
  readonly directories: readonly string[];
  /** The package script that builds the package, run in each directory. */
  readonly script: string;
  /** The built package, from each directory: what is packed and published. */
  readonly output: string;
  /**
   * `declared`: the directory's own manifest holds the version, which a release raises by the
   * titles of its changes, or a person sets by hand for a major.
   * `derived`: the build writes the major and minor, at patch 0, and a release sets the patch.
   */
  readonly versioning: "declared" | "derived";
  /**
   * When a release's final is published. `merge`: as the release merges, and the package is never
   * published otherwise. `production`: once production serves what the package calls, so a
   * gateway's package never offers a schema production does not. Until then, each merge that
   * changes it publishes a candidate.
   */
  readonly finalAt: "merge" | "production";
}

export const SOURCES: readonly Source[] = [
  {
    group: "Gateway client",
    directories: ["gateways/shared/client"],
    script: "build",
    output: "dist",
    versioning: "declared",
    finalAt: "merge",
  },
  {
    group: "Gateways",
    directories: ["gateways/services/*"],
    script: "codegen",
    output: ".gen/client/package",
    versioning: "derived",
    finalAt: "production",
  },
];
