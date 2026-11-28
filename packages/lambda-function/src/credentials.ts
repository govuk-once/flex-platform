/** A role's credentials, which are temporary, so they always carry a session token. */
export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

/**
 * The function's role's credentials, from the variables Lambda sets for each invocation. Lambda
 * rotates them, so they are read for each request rather than kept.
 */
export function credentialsFromEnvironment(): Credentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error("The role's credentials aren't in the environment");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}
