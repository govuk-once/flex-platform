import { fileURLToPath } from "node:url";

import { cdkApp } from "@repo/infra-constructs";
import { Stack, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

export const ACCOUNT = "123456789012";

/** A stand-in for a gateway's bundle, beside a file that isn't part of it. */
export const BUNDLE = fileURLToPath(
  new URL("bundle/bundle.mjs", import.meta.url),
);

export function stack(nag = false): Stack {
  const app = cdkApp();

  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));

  return new Stack(app, "Test", {
    env: { account: ACCOUNT, region: "eu-west-2" },
  });
}
