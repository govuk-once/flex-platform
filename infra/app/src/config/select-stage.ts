import type { StageConfig } from "./types.ts";

// A deploy targets one stage, so the app builds only the stage it's asked for. That selects what
// to build; it never changes how a stage is built.
export function selectStage<const T extends StageConfig>(
  stages: readonly T[],
  name: unknown,
): T {
  const known = stages.map((stage) => stage.name);
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `Pass the stage to build with -c stage=<name>. Known stages: ${known.join(", ") || "none"}`,
    );
  }
  const stage = stages.find((candidate) => candidate.name === name);
  if (!stage) {
    throw new Error(
      `Unknown stage ${JSON.stringify(name)}. Known stages: ${known.join(", ") || "none"}`,
    );
  }
  return stage;
}
