// Signs in as a test user and calls a domain through the Frontdoor:
// `tsx bin/call-domain.ts <stage> <environment> <path>`, such as
// `tsx bin/call-domain.ts platform-dev development /app/example/hello`, with FLEX_TEST_USERNAME
// and FLEX_TEST_PASSWORD set. It takes the pool, its client and the Frontdoor's address from
// config, and needs no AWS credentials: Cognito's InitiateAuth is public. It prints the answer,
// and never the token or the password. Exits non-zero unless the answer is a 2xx.

import { isRecord } from "@repo/utils/is-record";
import { printable } from "@repo/utils/printable";
import { printableText } from "@repo/utils/printable-text";
import { requiredEnv } from "@repo/utils/required-env";

import { STAGES } from "../src/config/stages.ts";
import { selectStage } from "../src/config/utils/select-stage.ts";

const USAGE =
  "Usage: call-domain.ts <stage> <environment> <path>, where <path> is /app/<domain>/...";

function stringField(value: unknown, name: string): string | undefined {
  const field = isRecord(value) ? value[name] : undefined;
  return typeof field === "string" ? field : undefined;
}

const [stageName, environmentName, path] = process.argv.slice(2);
// The path is written straight after the Frontdoor's host, so it starts as the Frontdoor's paths
// do: anything else could name another host, and send the token there.
if (
  stageName === undefined ||
  environmentName === undefined ||
  path?.startsWith("/app/") !== true
) {
  throw new Error(USAGE);
}

const stage = selectStage(STAGES, stageName);
const environment = stage.environments.find(
  ({ name }) => name === environmentName,
);
if (!environment) {
  const known = stage.environments.map(({ name }) => name).join(", ");
  throw new Error(
    `Unknown environment ${JSON.stringify(environmentName)}. ${stage.name} has: ${known}`,
  );
}
const pool = environment.frontdoor.testUserIssuer;
const clientId = pool?.clientIds[0];
if (!pool || clientId === undefined) {
  throw new Error(
    `${stage.name}/${environment.name} doesn't trust test users, so its Frontdoor would refuse the token`,
  );
}

// Cognito's API is at the issuer's origin: the issuer is that origin and the pool's ID.
const cognito = new URL("/", pool.issuer);

async function signIn(username: string, password: string): Promise<string> {
  const response = await fetch(cognito, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `Cognito refused the sign-in with ${stringField(body, "__type") ?? String(response.status)}: ${stringField(body, "message") ?? "no message"}`,
    );
  }
  // A user created with a temporary password is asked for a new one, not given a token.
  const challenge = stringField(body, "ChallengeName");
  if (challenge !== undefined) {
    throw new Error(
      `Cognito answered with the challenge ${challenge}, not a token. Give the user a permanent password.`,
    );
  }
  const result = isRecord(body) ? body["AuthenticationResult"] : undefined;
  const token = stringField(result, "AccessToken");
  if (token === undefined) throw new Error("Cognito answered with no token");
  return token;
}

const token = await signIn(
  requiredEnv("FLEX_TEST_USERNAME"),
  requiredEnv("FLEX_TEST_PASSWORD"),
);

const url = `https://${environment.frontdoor.zone.name}${path}`;
// A redirect is the answer, not somewhere to follow with the token.
const response = await fetch(url, {
  headers: { authorization: `Bearer ${token}` },
  redirect: "manual",
});

console.log(printable(`GET ${url}`));
console.log(printable(`${String(response.status)} ${response.statusText}`));
for (const name of ["x-correlation-id", "x-rejected-by", "content-type"]) {
  const value = response.headers.get(name);
  if (value !== null) console.log(printable(`${name}: ${value}`));
}
console.log();
// The path came from the command line and the rest from the domain, so each is printable. The body
// keeps its own lines, so a JSON answer stays readable.
console.log(printableText(await response.text()));

if (!response.ok) process.exitCode = 1;
