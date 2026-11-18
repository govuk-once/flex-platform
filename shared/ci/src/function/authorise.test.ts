import { describe, expect, it } from "vitest";

import { CONFIG, OWNER_ID, REPOSITORY_ID } from "../../test/helpers.ts";
import { createAuthoriser, createPublishCheck } from "./authorise.ts";
import type { Pipeline } from "./token.ts";

const PIPELINE: Pipeline = {
  repositoryId: REPOSITORY_ID,
  ownerId: OWNER_ID,
  environment: "development",
  runId: "12345678901",
  commit: undefined,
};

const TARGET = { environment: "development", domain: "example" };

const authorise = createAuthoriser(CONFIG);

describe("createAuthoriser", () => {
  it("allows the registered repository's pipeline, in the environment its job runs in", () => {
    expect(authorise(PIPELINE, TARGET)).toBeUndefined();
  });

  it("allows it in each environment that hosts the domain, when the job runs there", () => {
    expect(
      authorise(
        { ...PIPELINE, environment: "staging" },
        { environment: "staging", domain: "example" },
      ),
    ).toBeUndefined();
  });

  it.each([
    ["environment-unknown", PIPELINE, { ...TARGET, environment: "production" }],
    ["environment-unknown", PIPELINE, { ...TARGET, environment: "toString" }],
    ["environment-unknown", PIPELINE, { ...TARGET, environment: "" }],
    ["domain-not-hosted", PIPELINE, { ...TARGET, domain: "elsewhere" }],
    ["domain-not-hosted", PIPELINE, { ...TARGET, domain: "constructor" }],
    ["domain-not-hosted", PIPELINE, { ...TARGET, domain: "unknown" }],
    // Hosted, but its repository doesn't exist yet.
    ["domain-unregistered", PIPELINE, { ...TARGET, domain: "unregistered" }],
    ["repository", { ...PIPELINE, repositoryId: "700000002" }, TARGET],
    // The repository, transferred to another owner.
    ["owner", { ...PIPELINE, ownerId: "90000002" }, TARGET],
    ["environment-claim", { ...PIPELINE, environment: "staging" }, TARGET],
    // A job that runs in no environment.
    ["environment-claim", { ...PIPELINE, environment: undefined }, TARGET],
    ["environment-claim", { ...PIPELINE, environment: "Development" }, TARGET],
  ] as const)("refuses as %s", (refusal, pipeline, target) => {
    expect(authorise(pipeline, target)).toBe(refusal);
  });

  // Another domain's repository can't release this one, even from the same owner.
  it("holds each domain to its own repository", () => {
    const both = createAuthoriser({
      environments: [
        {
          name: "development",
          publishes: true,
          domains: ["example", "other"],
        },
      ],
      domains: [
        { name: "example", repositoryId: REPOSITORY_ID, ownerId: OWNER_ID },
        { name: "other", repositoryId: "700000002", ownerId: OWNER_ID },
      ],
    });

    expect(both(PIPELINE, { ...TARGET, domain: "other" })).toBe("repository");
    expect(both({ ...PIPELINE, repositoryId: "700000002" }, TARGET)).toBe(
      "repository",
    );
  });

  it("allows nothing when the config holds nothing", () => {
    const none = createAuthoriser({ environments: [], domains: [] });

    expect(none(PIPELINE, TARGET)).toBe("environment-unknown");
  });
});

describe("createPublishCheck", () => {
  const publishes = createPublishCheck(CONFIG);

  it("holds only for an environment that publishes", () => {
    expect(publishes("development")).toBe(true);
    expect(publishes("staging")).toBe(false);
  });

  it.each(["production", "toString", "constructor", ""])(
    "holds for none in %j, which the config doesn't hold",
    (environment) => {
      expect(publishes(environment)).toBe(false);
    },
  );
});
