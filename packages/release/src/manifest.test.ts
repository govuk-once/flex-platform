import { describe, expect, it } from "vitest";

import { type PublishedAs, publishedManifest } from "./manifest.ts";

const as = (fields: Partial<PublishedAs> = {}): PublishedAs => ({
  version: "0.3.0",
  workspace: new Map([["@govuk-once/client", "0.2.0"]]),
  repository: { type: "git", url: "https://example.com/repo.git" },
  directory: "domains/sdk",
  ...fields,
});

describe("publishedManifest", () => {
  it("is the built manifest under the decided version, naming its repository", () => {
    expect(
      publishedManifest(
        { name: "@govuk-once/sdk", version: "0.0.0", type: "module" },
        as(),
      ),
    ).toEqual({
      name: "@govuk-once/sdk",
      version: "0.3.0",
      type: "module",
      repository: {
        type: "git",
        url: "https://example.com/repo.git",
        directory: "domains/sdk",
      },
    });
  });

  it("names the workspace's version in place of each form of workspace link", () => {
    const built = {
      name: "@govuk-once/sdk",
      version: "0.3.0",
      dependencies: { "@govuk-once/client": "workspace:*" },
      peerDependencies: { "@govuk-once/client": "workspace:^" },
      optionalDependencies: { "@govuk-once/client": "workspace:>=0.1.0" },
    };

    expect(publishedManifest(built, as())).toMatchObject({
      dependencies: { "@govuk-once/client": "0.2.0" },
      peerDependencies: { "@govuk-once/client": "^0.2.0" },
      optionalDependencies: { "@govuk-once/client": ">=0.1.0" },
    });
  });

  it("refuses a link to a package this repository does not publish", () => {
    const built = {
      name: "@govuk-once/sdk",
      version: "0.3.0",
      dependencies: { "@repo/utils": "workspace:*" },
    };

    expect(() => publishedManifest(built, as())).toThrow(
      "links @repo/utils, which this repository does not publish.",
    );
  });
});
