import { Stack, Validations } from "aws-cdk-lib";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";

import { PlatformBucket } from "../bucket.ts";
import { cdkApp } from "../cdk-app.ts";
import { BUCKET_HTTPS_RULE, BucketHttpsCheck } from "./bucket-https-check.ts";

function checkedStack() {
  const app = cdkApp();
  Validations.of(app).addPlugins(new BucketHttpsCheck());
  const stack = new Stack(app, "Test", {
    env: { account: "123456789012", region: "eu-west-2" },
  });
  return { app, stack };
}

describe("BucketHttpsCheck", () => {
  it("passes a PlatformBucket", () => {
    const { app, stack } = checkedStack();
    new PlatformBucket(stack, "Store");

    expect(() => app.synth()).not.toThrow();
  });

  it("passes a bucket that denies plain HTTP and old TLS itself", () => {
    const { app, stack } = checkedStack();
    new Bucket(stack, "Store", { enforceSSL: true, minimumTLSVersion: 1.2 });

    expect(() => app.synth()).not.toThrow();
  });

  it("fails synth on a bucket with CDK's defaults", () => {
    const { app, stack } = checkedStack();
    new Bucket(stack, "Store");

    expect(() => app.synth()).toThrow(BUCKET_HTTPS_RULE);
  });

  it("passes a bucket that denies TLS older than a later version", () => {
    const { app, stack } = checkedStack();
    new Bucket(stack, "Store", { enforceSSL: true, minimumTLSVersion: 1.3 });

    expect(() => app.synth()).not.toThrow();
  });

  it("fails synth on a bucket that denies only TLS older than an earlier version", () => {
    const { app, stack } = checkedStack();
    new Bucket(stack, "Store", { enforceSSL: true, minimumTLSVersion: 1.1 });

    expect(() => app.synth()).toThrow(BUCKET_HTTPS_RULE);
  });

  it("fails synth on a bucket that denies plain HTTP but allows old TLS", () => {
    const { app, stack } = checkedStack();
    new Bucket(stack, "Store", { enforceSSL: true });

    expect(() => app.synth()).toThrow(BUCKET_HTTPS_RULE);
  });

  // Denials written by hand, as CDK writes its own, but for their conditions.
  it.each<[string, Record<string, Record<string, unknown>>[]]>([
    [
      "denies them only for one principal",
      [
        {
          Bool: { "aws:SecureTransport": "false" },
          StringEquals: {
            "aws:PrincipalArn": "arn:aws:iam::123456789012:root",
          },
        },
        {
          NumericLessThan: { "s3:TlsVersion": 1.2 },
          StringEquals: {
            "aws:PrincipalArn": "arn:aws:iam::123456789012:root",
          },
        },
      ],
    ],
    [
      "denies only requests that are both",
      [
        {
          Bool: { "aws:SecureTransport": "false" },
          NumericLessThan: { "s3:TlsVersion": 1.2 },
        },
      ],
    ],
  ])("fails synth on a bucket that %s", (_, conditions) => {
    const { app, stack } = checkedStack();
    const bucket = new Bucket(stack, "Store");
    for (const condition of conditions) {
      bucket.addToResourcePolicy(
        new PolicyStatement({
          effect: Effect.DENY,
          principals: [new AnyPrincipal()],
          actions: ["s3:*"],
          resources: [bucket.bucketArn, bucket.arnForObjects("*")],
          conditions: condition,
        }),
      );
    }

    expect(() => app.synth()).toThrow(BUCKET_HTTPS_RULE);
  });

  it("passes a bucket whose hand-written denials hold one condition each", () => {
    const { app, stack } = checkedStack();
    const bucket = new Bucket(stack, "Store");
    for (const condition of [
      { Bool: { "aws:SecureTransport": "false" } },
      { NumericLessThan: { "s3:TlsVersion": 1.2 } },
    ]) {
      bucket.addToResourcePolicy(
        new PolicyStatement({
          effect: Effect.DENY,
          principals: [new AnyPrincipal()],
          actions: ["s3:*"],
          resources: [bucket.bucketArn, bucket.arnForObjects("*")],
          conditions: condition,
        }),
      );
    }

    expect(() => app.synth()).not.toThrow();
  });
});
