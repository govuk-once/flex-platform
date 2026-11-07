import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

export interface UpstreamAccessProps {
  /** The secret the gateway reads, by ARN, or by a pattern for one Secrets Manager names. */
  readonly secretArn: string;
  /** The key an upstream encrypts the secret with, if it holds the secret, by ARN. */
  readonly secretKeyArn: string | null;
  /** The roles it assumes to sign as, by ARN. */
  readonly roleArns: readonly string[];
  /** The network's `secretsmanager` and `sts` endpoints, by ID. */
  readonly endpointIds: readonly string[];
}

/**
 * What a gateway's role may do to reach its upstream: read its own secret, and assume its
 * upstream's roles, each only through the network's endpoints. The deny refuses the same calls by
 * any other way, through NAT or from outside AWS with the role's credentials, so no other grant can
 * open them.
 */
export function upstreamAccess(props: UpstreamAccessProps): PolicyStatement[] {
  const statements = [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: [props.secretArn],
    }),
    new PolicyStatement({
      effect: Effect.DENY,
      actions: ["secretsmanager:GetSecretValue", "sts:AssumeRole"],
      resources: ["*"],
      conditions: {
        StringNotEquals: { "aws:SourceVpce": [...props.endpointIds] },
      },
    }),
  ];

  // An upstream's secret is encrypted with a key of its own, which Secrets Manager uses as the
  // caller. A secret of the gateway's own uses the account's key for Secrets Manager.
  if (props.secretKeyArn !== null) {
    statements.push(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: [props.secretKeyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `secretsmanager.${regionOf(props.secretArn)}.amazonaws.com`,
          },
        },
      }),
    );
  }

  if (props.roleArns.length > 0) {
    statements.push(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [...props.roleArns],
      }),
    );
  }

  return statements;
}

// A secret's ARN names its region, which is the gateway's: Secrets Manager has no cross-region
// endpoint.
function regionOf(arn: string): string {
  const region = arn.split(":")[3];
  if (region === undefined || region === "") {
    throw new Error(`The secret ARN ${arn} names no region.`);
  }
  return region;
}
