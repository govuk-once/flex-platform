import { heldValue } from "@repo/utils/held-value";
import { sortedEntries } from "@repo/utils/sorted-entries";

import type { StackInventory } from "./inventory.ts";

/**
 * The waves `.github/workflows/_deploy.yml` has a job for. A stage whose stacks need more fails
 * its plan, before anything deploys, and a test holds every committed stage to it.
 */
export const DEPLOY_WAVES = 3;

/** One account's stacks in one wave, which one job deploys as that account's role. */
export interface AccountDeploy {
  readonly account: string;
  readonly stacks: readonly string[];
}

type PlannedStack = Pick<StackInventory, "name" | "account" | "dependencies">;

/**
 * The order a stage deploys in: each stack in the wave after the last of its dependencies, and
 * each wave's stacks grouped by account, since an account's role deploys only into its own account.
 * Accounts in a wave deploy alongside each other.
 */
export function deployWaves(
  stacks: readonly PlannedStack[],
): AccountDeploy[][] {
  const byName = new Map(stacks.map((stack) => [stack.name, stack]));
  const waveOf = new Map<string, number>();
  const visiting = new Set<string>();

  const place = (name: string): number => {
    const placed = waveOf.get(name);
    if (placed !== undefined) return placed;
    if (visiting.has(name)) {
      throw new Error(
        `The stacks depend on each other in a cycle through ${name}`,
      );
    }
    visiting.add(name);
    const wave =
      Math.max(-1, ...heldValue(byName, name).dependencies.map(place)) + 1;
    visiting.delete(name);
    waveOf.set(name, wave);
    return wave;
  };

  const waves: Map<string, string[]>[] = [];
  for (const stack of stacks) {
    // The account names the GitHub environment variable that holds its role, so it must be one.
    if (!/^\d{12}$/.test(stack.account)) {
      throw new Error(
        `${stack.name} is in "${stack.account}", which is not an account ID`,
      );
    }
    const wave = place(stack.name);
    if (wave >= DEPLOY_WAVES) {
      throw new Error(
        `${stack.name} deploys in wave ${String(wave + 1)}, but the deploy workflow has ${String(DEPLOY_WAVES)}. Add a wave to .github/workflows/_deploy.yml and DEPLOY_WAVES.`,
      );
    }
    const accounts = (waves[wave] ??= new Map());
    const accountStacks = accounts.get(stack.account) ?? [];
    accounts.set(stack.account, [...accountStacks, stack.name]);
  }

  return Array.from({ length: waves.length }, (_, wave) =>
    sortedEntries(Object.fromEntries(waves[wave] ?? [])).map(
      ([account, accountStacks]) => ({ account, stacks: accountStacks }),
    ),
  );
}
