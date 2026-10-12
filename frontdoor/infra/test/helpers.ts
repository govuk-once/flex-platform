import { App, Stack, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";

import { Edge } from "../src/edge.ts";
import { ViewerRequestFunction } from "../src/viewer-request-function.ts";

export const DOMAIN_NAME = "sandbox.flex.example";

export const ISSUERS = [
  {
    issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_example",
    clientIds: ["example-app-client"],
  },
];

export function stackIn(region: string, nag = false): Stack {
  const app = new App();
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return new Stack(app, "Test", {
    env: { account: "123456789012", region },
  });
}

export function edgeIn(stack: Stack): Edge {
  const viewerRequest = new ViewerRequestFunction(stack, "ViewerRequest", {
    issuers: ISSUERS,
  });
  return new Edge(stack, "Edge", {
    environment: "sandbox",
    domainName: DOMAIN_NAME,
    viewerRequestFunction: viewerRequest.function,
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
