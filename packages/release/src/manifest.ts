import { isRecord } from "@repo/utils/is-record";

import { DEPENDENCY_FIELDS, type Manifest } from "./workspace.ts";

// The manifest a package is published with: the built one, under the version the release
// decided, naming the versions of what it depends on in place of the workspace's links, and the
// repository it comes from, which is how GitHub Packages links a package to this repository's
// permissions.

export interface Repository {
  readonly type: string;
  readonly url: string;
}

export interface PublishedAs {
  readonly version: string;
  /** The workspace's own version of each package a `workspace:` link may name. */
  readonly workspace: ReadonlyMap<string, string>;
  readonly repository: Repository;
  /** The workspace package's directory, from the workspace root. */
  readonly directory: string;
}

function resolveWorkspaceLink(
  name: string,
  spec: string,
  workspace: ReadonlyMap<string, string>,
): string {
  const range = spec.slice("workspace:".length);
  const version = workspace.get(name);
  if (version === undefined) {
    throw new Error(
      `The package links ${name}, which this repository does not publish.`,
    );
  }
  if (range === "*") return version;
  if (range === "^" || range === "~") return `${range}${version}`;
  return range;
}

export function publishedManifest(
  built: Manifest,
  as: PublishedAs,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    ...built,
    version: as.version,
    repository: { ...as.repository, directory: as.directory },
  };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = built[field];
    if (deps === undefined) continue;
    if (!isRecord(deps)) {
      throw new Error(`${built.name}'s ${field} is not an object.`);
    }
    manifest[field] = Object.fromEntries(
      Object.entries(deps).map(([name, spec]) => {
        if (typeof spec !== "string") {
          throw new Error(
            `${built.name}'s ${field} gives ${name} as something other than a range.`,
          );
        }
        const range = spec.startsWith("workspace:")
          ? resolveWorkspaceLink(name, spec, as.workspace)
          : spec;
        return [name, range];
      }),
    );
  }
  return manifest;
}
