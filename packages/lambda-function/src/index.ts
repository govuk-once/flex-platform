// What a Lambda function's code uses. A function bundles what it imports from here, so all of it
// runs in Lambda's Node runtime. The build is a separate entry, which runs where CDK does.
export { type Credentials, credentialsFromEnvironment } from "./credentials.ts";
export {
  createJwtVerifier,
  type JwtIssuer,
  type JwtRejectionReason,
  KEYS_BACKOFF_MS,
  KEYS_MAX_AGE_MS,
  type VerifyJwt,
} from "./jwt-verifier.ts";
