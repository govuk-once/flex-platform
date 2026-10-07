export type Environment = "development" | "staging" | "production";

const ENVIRONMENTS: readonly Environment[] = [
  "development",
  "staging",
  "production",
];

export const MAX_STAGE_LENGTH = 12;

export interface Stage {
  readonly name: string;
  readonly environment: Environment;
  readonly persistent: boolean;
}

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

export function sanitiseStageName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, MAX_STAGE_LENGTH);
}

export function resolveStage(env: NodeJS.ProcessEnv = process.env): Stage {
  const raw = env.STAGE ?? env.USER;
  const name = raw === undefined ? "" : sanitiseStageName(raw);

  if (name === "") {
    throw new Error(
      "Set STAGE to the environment or ephemeral stage to deploy",
    );
  }

  const persistent = isEnvironment(name);

  return {
    name,
    environment: persistent ? name : "development",
    persistent,
  };
}
