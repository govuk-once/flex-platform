import { type App, Stack, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

import { cdkApp } from "../src/cdk-app.ts";
import { LogGroupCheck } from "../src/validation/log-group-check.ts";

export const ACCOUNT = "123456789012";

/** A stack in a region, in an app that runs the synth checks when `checks` is set. */
export function stackIn(
  region: string,
  checks = false,
): { app: App; stack: Stack } {
  const app = cdkApp();
  if (checks) {
    Validations.of(app).addPlugins(
      new AwsSolutionsChecks(app),
      new LogGroupCheck(),
    );
  }
  const stack = new Stack(app, "Test", { env: { account: ACCOUNT, region } });
  return { app, stack };
}
