import { sortedNames } from "@repo/utils/sorted-names";
import type { CloudAssembly } from "aws-cdk-lib/cx-api";

export interface ResourceInventory {
  readonly logicalId: string;
  readonly type: string;
}

export interface StackInventory {
  readonly name: string;
  readonly account: string;
  readonly region: string;
  /** The stacks this one deploys after, by name. */
  readonly dependencies: readonly string[];
  readonly resources: readonly ResourceInventory[];
}

/**
 * What an assembly deploys, stack by stack, in the one order everything reproducible uses: each
 * stack's place and what it waits for, and each resource's logical ID and type. A changed logical
 * ID replaces the resource, so this is what a review must see change.
 */
export function inventory(assembly: CloudAssembly): StackInventory[] {
  // Dependencies name artifacts, which include each stack's asset manifest.
  const names = new Map(
    assembly.stacks.map((stack) => [stack.id, stack.stackName]),
  );
  const stacks = new Map(
    assembly.stacks.map((stack) => [stack.stackName, stack]),
  );
  return sortedNames(stacks.keys()).map((name) => {
    const stack = stacks.get(name)!;
    const { Resources: resources = {} } = stack.template as {
      Resources?: Record<string, { Type: string }>;
    };
    return {
      name,
      account: stack.environment.account,
      region: stack.environment.region,
      dependencies: sortedNames(
        stack.dependencies.flatMap((dependency) => {
          const dependencyName = names.get(dependency.id);
          return dependencyName === undefined ? [] : [dependencyName];
        }),
      ),
      resources: sortedNames(Object.keys(resources)).map((logicalId) => ({
        logicalId,
        type: resources[logicalId]!.Type,
      })),
    };
  });
}
