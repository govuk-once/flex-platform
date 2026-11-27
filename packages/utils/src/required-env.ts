/** An environment, as `process.env` is one: a variable may be unset. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The value of an environment variable that must be set. Unset, or set to nothing but space, is
 * refused alike: the two read alike to a deployment tool.
 */
export function requiredEnv(name: string, env: Env = process.env): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Environment variable ${name} must be set`);
  }
  return value;
}
