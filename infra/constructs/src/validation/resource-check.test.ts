import { Stack, Validations } from "aws-cdk-lib";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { describe, expect, it } from "vitest";

import { cdkApp } from "../cdk-app.ts";
import { ResourceCheck } from "./resource-check.ts";

// A check that refuses every queue, so each one is a finding.
class NoQueuesCheck extends ResourceCheck {
  constructor() {
    super({
      name: "Test-NoQueues",
      description: "No queues.",
      fix: "Remove it.",
      type: "AWS::SQS::Queue",
      faults: () => ["Type"],
    });
  }
}

function appRefusingQueues() {
  const app = cdkApp();
  Validations.of(app).addPlugins(new NoQueuesCheck());
  const stack = (id: string) =>
    new Stack(app, id, {
      env: { account: "123456789012", region: "eu-west-2" },
    });
  return { app, stack };
}

describe("ResourceCheck", () => {
  it("looks only at resources of its type", () => {
    const { app, stack } = appRefusingQueues();
    new Topic(stack("First"), "Topic");

    expect(() => app.synth()).not.toThrow();
  });

  it("reports a resource at fault in any template, under the rule's name", () => {
    const { app, stack } = appRefusingQueues();
    new Topic(stack("First"), "Topic");
    new Queue(stack("Second"), "Queue");

    expect(() => app.synth()).toThrow(/Test-NoQueues[\s\S]*Second/);
  });
});
