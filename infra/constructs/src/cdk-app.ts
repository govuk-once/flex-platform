import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { App } from "aws-cdk-lib";

// The committed feature flags live in the app's cdk.json, where CDK's tooling expects them. A
// package can't import them from @repo/infra-app, which depends on every construct package, so
// they're read by path. A test on CDK's defaults would check an app that is never deployed.
const CDK_JSON = new URL("../../app/cdk.json", import.meta.url);

export function readFeatureFlags(file: URL): Record<string, unknown> {
  const path = fileURLToPath(file);
  if (!existsSync(path)) {
    throw new Error(
      `CDK's feature flags are read from ${path}, which doesn't exist. Point cdk-app.ts at the app's cdk.json.`,
    );
  }
  const { context } = JSON.parse(readFileSync(path, "utf8")) as {
    context?: unknown;
  };
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    throw new Error(`${path} has no context holding CDK's feature flags.`);
  }
  return context as Record<string, unknown>;
}

/**
 * An app with the committed feature flags, as the platform deploys it. The deployed app and every
 * CDK test are built with it. The flags are defaults: context from the CLI, such as `-c stage`,
 * still applies.
 */
export function cdkApp(context: Record<string, unknown> = {}): App {
  return new App({
    context: { ...readFeatureFlags(CDK_JSON), ...context },
  });
}
