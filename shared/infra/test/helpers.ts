import { cdkApp, LogGroupCheck } from "@repo/infra-constructs";
import { App, Stack, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { assert } from "vitest";

import { ManagementEdge } from "../src/management-edge.ts";
import { ManagementViewerRequestFunction } from "../src/management-viewer-request-function.ts";

export const ACCOUNT = "123456789012";

export const ZONE = {
  zoneName: "sandbox.flex-shared.example",
  hostedZoneId: "Z100000000001",
};

export const CI_ORIGIN_HOST = "abcdefghij.lambda-url.eu-west-2.on.aws";

// With `nag`, the stack's app runs cdk-nag and the platform's log group check at synth.
export function stackIn(region: string, nag = false): Stack {
  const app = cdkApp();

  if (nag) {
    Validations.of(app).addPlugins(
      new AwsSolutionsChecks(app),
      new LogGroupCheck(),
    );
  }

  return new Stack(app, "Test", { env: { account: ACCOUNT, region } });
}

export function appOf(stack: Stack): App {
  const app = stack.node.root;
  assert.instanceOf(app, App);
  return app;
}

// The function is built in `functionStack` when it is given, so a test can build the edge
// somewhere the function refuses to be.
export function managementEdgeIn(
  stack: Stack,
  functionStack = stack,
): ManagementEdge {
  const viewerRequest = new ManagementViewerRequestFunction(
    functionStack,
    "ViewerRequest",
    { zoneName: ZONE.zoneName },
  );
  return new ManagementEdge(stack, "Edge", {
    zone: ZONE,
    viewerRequestFunction: viewerRequest.function,
    ciOriginHost: CI_ORIGIN_HOST,
  });
}

export function managementEdgeTemplate(nag = false): {
  edge: ManagementEdge;
  app: App;
  template: Template;
} {
  const stack = stackIn("us-east-1", nag);
  const edge = managementEdgeIn(stack);
  return { edge, app: appOf(stack), template: Template.fromStack(stack) };
}
