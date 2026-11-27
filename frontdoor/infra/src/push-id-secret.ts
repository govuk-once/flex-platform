import { SIGNING_KEY_REGION } from "@repo/frontdoor-shared";
import { roleArn } from "@repo/infra-constructs";
import { RemovalPolicy, Stack, Validations } from "aws-cdk-lib";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { type CfnSecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

import { edgeRoleName, pushIdSecretName } from "./names.ts";

export interface PushIdSecretProps {
  readonly environment: string;
}

/**
 * The secret the edge derives each caller's push ID with. It is created empty, and a person puts
 * its value: until then the edge signs no caller token. Only the edge's role may read it, whatever
 * any other policy allows. It is retained, since it holds what a person put, and every push ID
 * derived with it is lost with it.
 */
export class PushIdSecret extends Construct {
  public readonly secret: Secret;

  constructor(
    scope: Construct,
    id: string,
    { environment }: PushIdSecretProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== SIGNING_KEY_REGION) {
      throw new Error(
        `The push ID secret is kept in ${SIGNING_KEY_REGION}, where the edge reads it, not ${stack.region}`,
      );
    }

    this.secret = new Secret(this, "Secret", {
      secretName: pushIdSecretName(environment),
      description:
        "The key the edge derives each caller's push ID with, which a person puts",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // CDK otherwise generates a password as its value. Every user's push ID depends on the value,
    // so it is one a person chose to put, never one a deploy made.
    (this.secret.node.defaultChild as CfnSecret).addPropertyDeletionOverride(
      "GenerateSecretString",
    );

    this.secret.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["secretsmanager:GetSecretValue"],
        resources: ["*"],
        conditions: {
          StringNotEquals: {
            "aws:PrincipalArn": roleArn(stack, edgeRoleName(environment)),
          },
        },
      }),
    );

    Validations.of(this.secret).acknowledge({
      id: "AwsSolutions-SMG4",
      reason:
        "A new value changes every user's push ID, so the secret is put once and never rotated.",
    });
  }
}
