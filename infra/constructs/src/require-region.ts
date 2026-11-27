import { Stack } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

/**
 * Refuses a scope whose stack is in any region but `region`, with `requirement` and the region it
 * is in, such as "A CloudFront web ACL must be created in us-east-1, not eu-west-2".
 */
export function requireRegion(
  scope: IConstruct,
  region: string,
  requirement: string,
): void {
  const actual = Stack.of(scope).region;
  if (actual !== region) throw new Error(`${requirement}, not ${actual}`);
}
