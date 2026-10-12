import type { EnvironmentConfig, StageConfig } from "./types.ts";

/** The shared account's stacks, which belong to no environment. */
export const SHARED_TARGET = "shared";

export interface Target {
  /** Whether the shared account's stacks are built. */
  readonly shared: boolean;
  /** The environments whose stacks are built. */
  readonly environments: readonly EnvironmentConfig[];
}

// A deploy may be narrowed to one environment, or to the shared account, with -c target=<name>;
// without it a stage is built whole. That selects what to build; it never changes how.
export function selectTarget(stage: StageConfig, name: unknown): Target {
  if (name === undefined) {
    return { shared: true, environments: stage.environments };
  }
  const known = [SHARED_TARGET, ...stage.environments.map((e) => e.name)];
  if (typeof name !== "string" || !known.includes(name)) {
    throw new Error(
      `Unknown target ${JSON.stringify(name)} for ${stage.name}. Known targets: ${known.join(", ")}`,
    );
  }
  if (name === SHARED_TARGET) return { shared: true, environments: [] };
  return {
    shared: false,
    environments: stage.environments.filter((e) => e.name === name),
  };
}
