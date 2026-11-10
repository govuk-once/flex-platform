import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn } from "../test/helpers.ts";
import { SigningKey } from "./signing-key.ts";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new SigningKey(stack, "SigningKey", { environment: "sandbox" });
  return { stack, template: Template.fromStack(stack) };
}

describe("SigningKey", () => {
  it("is a symmetric key, rotated, retained, and found by the alias every region shares", () => {
    const { template } = build();
    template.hasResource("AWS::KMS::Key", {
      Properties: { EnableKeyRotation: true },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    template.hasResourceProperties("AWS::KMS::Alias", {
      AliasName: "alias/frontdoor-sandbox-caller-token",
    });
  });

  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true)).not.toThrow();
  });
});
