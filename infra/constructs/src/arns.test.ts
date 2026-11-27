import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

import {
  accountOf,
  functionArn,
  logGroupArn,
  roleArn,
  tableArn,
} from "./arns.ts";
import { cdkApp } from "./cdk-app.ts";

const stack = new Stack(cdkApp(), "Test", {
  env: { account: "123456789012", region: "eu-west-2" },
});

describe("the ARN helpers", () => {
  it("name a role in the stack's account or another, with no region", () => {
    expect(roleArn(stack, "a-role")).toBe(
      "arn:aws:iam::123456789012:role/a-role",
    );
    expect(roleArn(stack, "a-role", "210987654321")).toBe(
      "arn:aws:iam::210987654321:role/a-role",
    );
  });

  it("name a function in the stack's account or another", () => {
    expect(functionArn(stack, "fn:live")).toBe(
      "arn:aws:lambda:eu-west-2:123456789012:function:fn:live",
    );
    expect(functionArn(stack, "fn-*", "210987654321")).toBe(
      "arn:aws:lambda:eu-west-2:210987654321:function:fn-*",
    );
  });

  it("name a log group, and a table in the stack's region or another", () => {
    expect(logGroupArn(stack, "/a/group")).toBe(
      "arn:aws:logs:eu-west-2:123456789012:log-group:/a/group",
    );
    expect(tableArn(stack, "a-table")).toBe(
      "arn:aws:dynamodb:eu-west-2:123456789012:table/a-table",
    );
    expect(tableArn(stack, "a-table", "us-east-1")).toBe(
      "arn:aws:dynamodb:us-east-1:123456789012:table/a-table",
    );
  });

  it("read the account a role's ARN names", () => {
    expect(accountOf("arn:aws:iam::123456789012:role/a-role")).toBe(
      "123456789012",
    );
    expect(() => accountOf("arn:aws:iam:::role/a-role")).toThrow(
      "names no account",
    );
  });
});
