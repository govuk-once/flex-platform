import { cdkApp } from "@repo/infra-constructs";
import { type App, Stack, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";

import { Edge } from "../src/edge.ts";
import { OriginRequestFunction } from "../src/origin-request-function.ts";
import { ViewerRequestFunction } from "../src/viewer-request-function.ts";

export const ISSUERS = [
  {
    issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_example",
    clientIds: ["example-app-client"],
  },
];

export const ZONE = {
  zoneName: "sandbox.flex-edge.example",
  hostedZoneId: "Z100000000002",
};

export function stackIn(region: string, nag = false): Stack {
  const app = cdkApp();
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return new Stack(app, "Test", {
    env: { account: "123456789012", region },
  });
}

export function edgeIn(stack: Stack): Edge {
  const viewerRequest = new ViewerRequestFunction(stack, "ViewerRequest", {
    environment: "sandbox",
    issuers: ISSUERS,
  });
  const originRequest = new OriginRequestFunction(stack, "OriginRequest", {
    environment: "sandbox",
    issuers: ISSUERS,
  });
  return new Edge(stack, "Edge", {
    environment: "sandbox",
    zone: ZONE,
    viewerRequestFunction: viewerRequest.function,
    originRequestFunction: originRequest.version,
  });
}

export function edgeTemplate(nag = false): {
  edge: Edge;
  app: App;
  template: Template;
} {
  const stack = stackIn("us-east-1", nag);
  const edge = edgeIn(stack);
  return {
    edge,
    app: stack.node.root as App,
    template: Template.fromStack(stack),
  };
}
