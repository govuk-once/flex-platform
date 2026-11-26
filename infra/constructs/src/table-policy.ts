import { sortedNames } from "@repo/utils/sorted-names";
import {
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";

/**
 * What anyone may do to a table, whatever its policy: see its settings and its policy, and manage
 * it as CloudFormation's `AWS::DynamoDB::Table` handler does on an update. So a deploy works under
 * whichever role it runs as, and the policy can always be rewritten. The handler's other actions
 * are left out: those that read or write an item, and those that copy items elsewhere, to a Kinesis
 * stream or a replica, which no table here uses.
 */
export const TABLE_MANAGEMENT_ACTIONS = [
  "dynamodb:DeleteResourcePolicy",
  "dynamodb:Describe*",
  "dynamodb:GetResourcePolicy",
  "dynamodb:ListTagsOfResource",
  "dynamodb:PutResourcePolicy",
  "dynamodb:TagResource",
  "dynamodb:UntagResource",
  "dynamodb:UpdateContinuousBackups",
  "dynamodb:UpdateContributorInsights",
  "dynamodb:UpdateTable",
  "dynamodb:UpdateTimeToLive",
] as const;

export interface TableRoles {
  /** Names its statement, `Deny<name>AllButItsWork`, so it is PascalCase. */
  readonly name: string;
  /** The roles, by ARN, which may hold a wildcard to name every role a pattern matches. */
  readonly roleArns: readonly string[];
  /** All the roles do to the table's items. */
  readonly actions: readonly string[];
}

export interface TablePolicyProps {
  /** By ARN, since the policy is part of the table, which can't name its own ARN. */
  readonly tableArn: string;
  /** Each set of roles that may use the table, and what each may do. No role is in two. */
  readonly roles: readonly TableRoles[];
  /** Anything else the table's policy holds, such as an allow for another account. */
  readonly statements?: readonly PolicyStatement[];
}

/**
 * A table's policy, which denies everything but what is named: to anyone but the roles given, all
 * but managing the table, and to each set of roles, all but its work. Naming what is allowed
 * covers every way to an item, PartiQL, exports, backups and restores among them, and any action
 * DynamoDB adds. A deny there holds whatever any principal's own policy allows.
 *
 * Managing the table is left to IAM, so no deploy is ever locked out. Whoever may rewrite the
 * policy may undo the rest, so who that is matters as much as the policy.
 */
export function tablePolicy(props: TablePolicyProps): PolicyDocument {
  const resources = [props.tableArn];
  const all = props.roles.flatMap(({ roleArns }) => [...new Set(roleArns)]);
  const twice = all.filter((arn, index) => all.indexOf(arn) !== index);
  if (twice.length > 0) {
    // Each set's deny would refuse the other's work, so the role could do neither.
    throw new Error(
      `A table's policy names ${sortedNames(new Set(twice)).join(", ")} in two sets of roles`,
    );
  }
  // A role's name can't hold a wildcard, so a role named exactly is matched as itself.
  const denyAllBut = (
    sid: string,
    notActions: readonly string[],
    condition: "ArnLike" | "ArnNotLike",
    roleArns: readonly string[],
  ) =>
    new PolicyStatement({
      sid,
      effect: Effect.DENY,
      principals: [new AnyPrincipal()],
      notActions: [...notActions],
      resources,
      ...(roleArns.length > 0 && {
        conditions: {
          [condition]: { "aws:PrincipalArn": sortedNames(new Set(roleArns)) },
        },
      }),
    });
  return new PolicyDocument({
    statements: [
      ...(props.statements ?? []),
      denyAllBut(
        "DenyOthersAllButManagingTheTable",
        TABLE_MANAGEMENT_ACTIONS,
        "ArnNotLike",
        all,
      ),
      ...props.roles
        .filter(({ roleArns }) => roleArns.length > 0)
        .map(({ name, roleArns, actions }) =>
          denyAllBut(`Deny${name}AllButItsWork`, actions, "ArnLike", roleArns),
        ),
    ],
  });
}
