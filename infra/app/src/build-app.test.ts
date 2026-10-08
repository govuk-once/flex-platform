import type { App } from "aws-cdk-lib";
import { Stack, Validations } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";

import { cdkApp, FIXTURE_STAGES } from "../test/helpers.ts";
import { buildApp } from "./build-app.ts";
import { PLATFORM_TAGS } from "./tags.ts";

const [STAGE] = FIXTURE_STAGES;

// A plain bucket has two known findings: no access logs, and plain HTTP allowed.
const BUCKET_FINDINGS = ["AwsSolutions-S1", "AwsSolutions-S10"];

function appWithBucket(): { app: App; stack: Stack; bucket: Bucket } {
  const app = cdkApp();
  buildApp(app, STAGE);
  const stack = new Stack(app, "probe");
  return { app, stack, bucket: new Bucket(stack, "Bucket") };
}

function acknowledge(
  scope: Stack | Bucket,
  ids: readonly string[] = BUCKET_FINDINGS,
): void {
  for (const id of ids) {
    Validations.of(scope).acknowledge({ id, reason: "Test probe only." });
  }
}

describe("buildApp", () => {
  describe("tags", () => {
    it("tags each stack with the platform's tags, its stage and the prune marker", () => {
      const { app, bucket } = appWithBucket();
      acknowledge(bucket);

      expect(app.synth().getStackByName("probe").tags).toEqual({
        ...PLATFORM_TAGS,
        Stage: STAGE.name,
        "flex:managed-by": "flex-platform",
      });
    });

    it("keeps a value a stack sets itself", () => {
      const app = cdkApp();
      buildApp(app, STAGE);
      const stack = new Stack(app, "probe", {
        tags: { Owner: "a-domain-team" },
      });
      acknowledge(new Bucket(stack, "Bucket"));

      expect(app.synth().getStackByName("probe").tags).toMatchObject({
        Owner: "a-domain-team",
        ResourceOwner: PLATFORM_TAGS.ResourceOwner,
      });
    });
  });

  describe("cdk-nag", () => {
    it("fails synth on a finding", () => {
      const { app } = appWithBucket();

      expect(() => app.synth()).toThrow(/AwsSolutions/);
    });

    it("fails synth while any finding is unacknowledged", () => {
      const { app, bucket } = appWithBucket();
      acknowledge(bucket, ["AwsSolutions-S1"]);

      expect(() => app.synth()).toThrow(/AwsSolutions-S10/);
    });

    it("passes synth once each finding is acknowledged on the resource", () => {
      const { app, bucket } = appWithBucket();
      acknowledge(bucket);

      expect(() => app.synth()).not.toThrow();
    });

    it("passes synth once each finding is acknowledged on the stack", () => {
      const { app, stack } = appWithBucket();
      acknowledge(stack);

      expect(() => app.synth()).not.toThrow();
    });
  });
});
