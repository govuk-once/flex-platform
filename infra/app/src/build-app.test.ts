import {
  API_IAM_RULE,
  BUCKET_HTTPS_RULE,
  cdkApp,
  LOG_GROUP_RULE,
} from "@repo/infra-constructs";
import type { App } from "aws-cdk-lib";
import { Stack, Validations } from "aws-cdk-lib";
import { AuthorizationType, CfnMethod } from "aws-cdk-lib/aws-apigateway";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES } from "../test/helpers.ts";
import { buildApp } from "./build-app.ts";
import type { Target } from "./config/select-target.ts";
import { PLATFORM_TAGS } from "./tags.ts";

const [STAGE] = FIXTURE_STAGES;

// The checks and the tags are the app's, whatever stacks it holds, so each test builds the app
// with none of its own stacks, no environment's and not the shared account's, and adds a stack of
// its own to probe. Every stage's synth runs the same checks over the stacks a stage does build.
const NO_STACKS: Target = { environments: [], shared: false };

// A plain queue has two known findings: no dead-letter queue, and plain HTTP allowed.
const PROBE_FINDINGS = ["AwsSolutions-SQS3", "AwsSolutions-SQS4"];

function appWithProbe(): { app: App; stack: Stack; queue: Queue } {
  const app = cdkApp();
  buildApp(app, STAGE, NO_STACKS);
  const stack = new Stack(app, "probe");
  return { app, stack, queue: new Queue(stack, "Queue") };
}

function acknowledge(
  scope: Stack | Queue | Bucket | CfnMethod,
  ids: readonly string[] = PROBE_FINDINGS,
): void {
  for (const id of ids) {
    Validations.of(scope).acknowledge({ id, reason: "Test probe only." });
  }
}

describe("buildApp", () => {
  describe("tags", () => {
    it("tags each stack with the platform's tags, its stage and the prune marker", () => {
      const { app, queue } = appWithProbe();
      acknowledge(queue);

      expect(app.synth().getStackByName("probe").tags).toEqual({
        ...PLATFORM_TAGS,
        Stage: STAGE.name,
        "flex:managed-by": "flex-platform",
      });
    });

    it("keeps a value a stack sets itself", () => {
      const app = cdkApp();
      buildApp(app, STAGE, NO_STACKS);
      const stack = new Stack(app, "probe", {
        tags: { Owner: "a-domain-team" },
      });
      acknowledge(new Queue(stack, "Queue"));

      expect(app.synth().getStackByName("probe").tags).toMatchObject({
        Owner: "a-domain-team",
        ResourceOwner: PLATFORM_TAGS.ResourceOwner,
      });
    });
  });

  describe("cdk-nag", () => {
    it("fails synth on a finding", () => {
      const { app } = appWithProbe();

      expect(() => app.synth()).toThrow(/AwsSolutions/);
    });

    it("fails synth while any finding is unacknowledged", () => {
      const { app, queue } = appWithProbe();
      acknowledge(queue, ["AwsSolutions-SQS3"]);

      expect(() => app.synth()).toThrow(/AwsSolutions-SQS4/);
    });

    it("passes synth once each finding is acknowledged on the resource", () => {
      const { app, queue } = appWithProbe();
      acknowledge(queue);

      expect(() => app.synth()).not.toThrow();
    });

    it("passes synth once each finding is acknowledged on the stack", () => {
      const { app, stack } = appWithProbe();
      acknowledge(stack);

      expect(() => app.synth()).not.toThrow();
    });
  });

  describe("the platform's checks", () => {
    it("fails synth on a log group not made by PlatformLogGroup", () => {
      const { app, stack, queue } = appWithProbe();
      acknowledge(queue);
      new LogGroup(stack, "Logs");

      expect(() => app.synth()).toThrow(LOG_GROUP_RULE);
    });

    it("fails synth on a bucket not made by PlatformBucket", () => {
      const { app, stack, queue } = appWithProbe();
      acknowledge(queue);
      const bucket = new Bucket(stack, "Store", {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        encryption: BucketEncryption.S3_MANAGED,
      });
      // cdk-nag's own findings on a bare bucket; only the platform's check is under test.
      acknowledge(bucket, ["AwsSolutions-S1", "AwsSolutions-S10"]);

      expect(() => app.synth()).toThrow(BUCKET_HTTPS_RULE);
    });

    it("fails synth on an API Gateway method cdk-nag accepts, authorised other than by IAM", () => {
      const { app, stack, queue } = appWithProbe();
      acknowledge(queue);
      const method = new CfnMethod(stack, "Method", {
        restApiId: "api",
        resourceId: "resource",
        httpMethod: "GET",
        authorizationType: AuthorizationType.CUSTOM,
        authorizerId: "authorizer",
      });
      // cdk-nag asks only for a Cognito authoriser here; it already refuses a method with none.
      acknowledge(method, ["AwsSolutions-COG4"]);

      expect(() => app.synth()).toThrow(API_IAM_RULE);
    });
  });
});
