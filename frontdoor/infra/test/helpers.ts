import { App, Stack, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { AwsSolutionsChecks } from "cdk-nag";

import { Edge, type EdgeProps } from "../src/edge.ts";

export const DOMAIN_NAME = "sandbox.flex.example";

export const EDGE_PROPS: EdgeProps = {
  environment: "sandbox",
  domainName: DOMAIN_NAME,
  issuers: [
    {
      issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_example",
      clientIds: ["example-app-client"],
    },
  ],
  rateLimitPerFiveMinutes: 2000,
  logRetention: RetentionDays.THREE_MONTHS,
};

export function stackIn(region: string, nag = false): Stack {
  const app = new App();
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return new Stack(app, "Test", {
    env: { account: "123456789012", region },
  });
}

export function edgeTemplate(
  overrides: Partial<EdgeProps> = {},
  nag = false,
): { edge: Edge; app: App; template: Template } {
  const stack = stackIn("us-east-1", nag);
  const edge = new Edge(stack, "Edge", { ...EDGE_PROPS, ...overrides });
  return {
    edge,
    app: stack.node.root as App,
    template: Template.fromStack(stack),
  };
}
