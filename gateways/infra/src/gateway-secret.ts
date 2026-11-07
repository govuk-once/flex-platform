import { RemovalPolicy, Validations } from "aws-cdk-lib";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { type CfnSecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface GatewaySecretProps {
  readonly secretName: string;
  /** The role of the gateway that reads it, by ARN. */
  readonly reader: string;
}

/**
 * A gateway's own secret, for an upstream that doesn't hold one. It is created empty, and a person
 * puts its value: a gateway whose secret has none fails as it starts. Only the gateway's role may
 * read it, whatever any other policy allows. It is retained, since it holds what a person put.
 */
export class GatewaySecret extends Construct {
  public readonly secret: Secret;

  constructor(scope: Construct, id: string, props: GatewaySecretProps) {
    super(scope, id);

    this.secret = new Secret(this, "Secret", {
      secretName: props.secretName,
      description: "The gateway's credentials, which a person puts",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // CDK otherwise generates a password as its value. The value is a JSON object of the fields
    // the gateway's configuration names, which nothing here can know.
    (this.secret.node.defaultChild as CfnSecret).addPropertyDeletionOverride(
      "GenerateSecretString",
    );

    this.secret.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["secretsmanager:GetSecretValue"],
        resources: ["*"],
        conditions: { StringNotEquals: { "aws:PrincipalArn": props.reader } },
      }),
    );

    Validations.of(this.secret).acknowledge({
      id: "AwsSolutions-SMG4",
      reason:
        "Rotation depends on the upstream, and is the gateway's own sidecar's to do, not a rotation Secrets Manager can schedule alone.",
    });
  }
}
