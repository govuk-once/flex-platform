import type { EnvironmentConfig, StageConfig } from "./types.ts";

/** The target that builds only the shared account's stacks. No environment may take its name. */
export const SHARED_TARGET = "shared";

export interface Target {
  /** The environments whose stacks are built. */
  readonly environments: readonly EnvironmentConfig[];
  /** Whether the shared account's stacks are built. */
  readonly shared: boolean;
}

// A deploy may be narrowed to one environment with -c target=<name>, or to the shared account with
// -c target=shared; without it a stage is built whole. That selects what to build; it never
// changes how.
export function selectTarget(stage: StageConfig, name: unknown): Target {
  if (name === undefined) {
    return { environments: stage.environments, shared: true };
  }
  if (name === SHARED_TARGET) return { environments: [], shared: true };
  const known = stage.environments.map((e) => e.name);
  if (typeof name !== "string" || !known.includes(name)) {
    throw new Error(
      `Unknown target ${JSON.stringify(name)} for ${stage.name}. Known targets: ${[...known, SHARED_TARGET].join(", ")}`,
    );
  }
  return {
    environments: stage.environments.filter((e) => e.name === name),
    shared: false,
  };
}
