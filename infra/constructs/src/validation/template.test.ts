import { describe, expect, it } from "vitest";

import {
  attachedPolicyStatements,
  coversResources,
  getAtt,
  hasAction,
  isAnyone,
  refersTo,
  soleCondition,
  type TemplateResources,
} from "./template.ts";

const DENY = { Effect: "Deny", Action: "s3:*" };
const ALLOW = { Effect: "Allow", Action: "s3:GetObject" };

const TEMPLATE: TemplateResources = {
  Store: { Type: "AWS::S3::Bucket" },
  StorePolicy: {
    Type: "AWS::S3::BucketPolicy",
    Properties: {
      Bucket: { Ref: "Store" },
      PolicyDocument: { Statement: [DENY] },
    },
  },
  StoreSecondPolicy: {
    Type: "AWS::S3::BucketPolicy",
    Properties: {
      Bucket: { Ref: "Store" },
      PolicyDocument: { Statement: [ALLOW] },
    },
  },
  OtherPolicy: {
    Type: "AWS::S3::BucketPolicy",
    Properties: {
      Bucket: { Ref: "Other" },
      PolicyDocument: { Statement: [{ Effect: "Deny" }] },
    },
  },
  StoreQueuePolicy: {
    Type: "AWS::SQS::QueuePolicy",
    Properties: {
      Bucket: { Ref: "Store" },
      PolicyDocument: { Statement: [{}] },
    },
  },
};

describe("attachedPolicyStatements", () => {
  it("gathers the statements of every policy of the type that names the resource", () => {
    expect(
      attachedPolicyStatements(
        TEMPLATE,
        "Store",
        "AWS::S3::BucketPolicy",
        "Bucket",
      ),
    ).toEqual([DENY, ALLOW]);
  });

  it("gives none when no policy names the resource", () => {
    expect(
      attachedPolicyStatements(
        TEMPLATE,
        "Missing",
        "AWS::S3::BucketPolicy",
        "Bucket",
      ),
    ).toEqual([]);
  });

  it("gives none from a policy whose document lists no statements", () => {
    const template: TemplateResources = {
      Store: { Type: "AWS::S3::Bucket" },
      StorePolicy: {
        Type: "AWS::S3::BucketPolicy",
        Properties: { Bucket: { Ref: "Store" }, PolicyDocument: {} },
      },
    };

    expect(
      attachedPolicyStatements(
        template,
        "Store",
        "AWS::S3::BucketPolicy",
        "Bucket",
      ),
    ).toEqual([]);
  });
});

describe("refersTo", () => {
  it("matches a Ref to the logical ID and nothing else", () => {
    expect(refersTo({ Ref: "Store" }, "Store")).toBe(true);
    expect(refersTo({ Ref: "Other" }, "Store")).toBe(false);
    expect(refersTo("Store", "Store")).toBe(false);
    expect(refersTo(undefined, "Store")).toBe(false);
  });
});

describe("isAnyone", () => {
  it.each([["*"], [{ AWS: "*" }]])("treats %j as anyone", (principal) => {
    expect(isAnyone(principal)).toBe(true);
  });

  it.each([
    [{ AWS: "arn:aws:iam::123456789012:root" }],
    [{ Service: "*" }],
    [undefined],
  ])("doesn't treat %j as anyone", (principal) => {
    expect(isAnyone(principal)).toBe(false);
  });
});

describe("hasAction", () => {
  it("finds the action written alone or in a list", () => {
    expect(hasAction({ Action: "s3:*" }, "s3:*")).toBe(true);
    expect(hasAction({ Action: ["s3:GetObject", "s3:*"] }, "s3:*")).toBe(true);
    expect(hasAction({ Action: "s3:GetObject" }, "s3:*")).toBe(false);
  });
});

describe("coversResources", () => {
  const arn = getAtt("Store", "Arn");
  const objects = { "Fn::Join": ["", [arn, "/*"]] };

  it("needs every resource, compared as written", () => {
    expect(coversResources({ Resource: [arn, objects] }, [arn, objects])).toBe(
      true,
    );
    expect(coversResources({ Resource: arn }, [arn])).toBe(true);
    expect(coversResources({ Resource: [objects] }, [arn, objects])).toBe(
      false,
    );
    expect(coversResources({ Resource: [getAtt("Other", "Arn")] }, [arn])).toBe(
      false,
    );
  });
});

describe("soleCondition", () => {
  it("reads one operator's key, and nothing when it's absent", () => {
    const statement = {
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    };
    expect(soleCondition(statement, "Bool", "aws:SecureTransport")).toBe(
      "false",
    );
    expect(
      soleCondition(statement, "NumericLessThan", "s3:TlsVersion"),
    ).toBeUndefined();
    expect(soleCondition({}, "Bool", "aws:SecureTransport")).toBeUndefined();
  });

  it.each([
    [
      "another key",
      {
        Bool: { "aws:SecureTransport": "false" },
        StringEquals: { "aws:PrincipalArn": "arn:aws:iam::123456789012:root" },
      },
    ],
    [
      "another key under the same operator",
      {
        Bool: { "aws:SecureTransport": "false", "aws:ViaAWSService": "false" },
      },
    ],
    [
      "another protection",
      {
        Bool: { "aws:SecureTransport": "false" },
        NumericLessThan: { "s3:TlsVersion": 1.2 },
      },
    ],
  ])("reads nothing when the condition also holds %s", (_, Condition) => {
    expect(
      soleCondition({ Condition }, "Bool", "aws:SecureTransport"),
    ).toBeUndefined();
  });
});
