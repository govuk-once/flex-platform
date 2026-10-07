import { CfnResource } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

export interface CheckovSkip {
  readonly id: string;
  readonly comment: string;
}

export function applyCheckovSkips(
  construct: IConstruct,
  skips: readonly CheckovSkip[],
): void {
  const resource =
    construct instanceof CfnResource ? construct : construct.node.defaultChild;

  if (!(resource instanceof CfnResource)) {
    throw new Error(
      `Cannot skip checkov checks on ${construct.node.path}: it has no CloudFormation resource`,
    );
  }

  resource.addMetadata("checkov", { skip: [...skips] });
}
