import type { EnvironmentConfig, StageConfig } from "./types.ts";

export interface Target {
  /** The environments whose stacks are built. */
  readonly environments: readonly EnvironmentConfig[];
}

// A deploy may be narrowed to one environment with -c target=<name>; without it a stage is built
// whole. That selects what to build; it never changes how.
export function selectTarget(stage: StageConfig, name: unknown): Target {
  if (name === undefined) return { environments: stage.environments };
  const known = stage.environments.map((e) => e.name);
  if (typeof name !== "string" || !known.includes(name)) {
    throw new Error(
      `Unknown target ${JSON.stringify(name)} for ${stage.name}. Known targets: ${known.join(", ")}`,
    );
  }
  return { environments: stage.environments.filter((e) => e.name === name) };
}
