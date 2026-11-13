import { RemovalPolicy, Validations } from "aws-cdk-lib";
import {
  AccountRecovery,
  FeaturePlan,
  Mfa,
  UserPool,
  type UserPoolClient,
} from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

import { TEST_USER_POOL_NAME } from "./names.ts";

/**
 * The shortest password the pool accepts. Every password is generated, never typed, and anyone
 * may try one through Cognito's public API, so its length is what protects it. Cognito allows
 * up to 99.
 */
export const MIN_PASSWORD_LENGTH = 64;

/**
 * The pool the Frontdoor trusts in an environment for testing: users that software signs in as,
 * each with a generated password, through Cognito's public API, so no AWS credentials are needed.
 * A person signs in as a test user only through software, so the pool has no MFA, no hosted
 * sign-in and no recovery. Only an administrator creates a user.
 *
 * Cognito generates the pool's and the client's IDs, so the Frontdoor's config names them once
 * the pool exists. The pool is retained and protected from deletion, so they never change.
 */
export class TestUserPool extends Construct {
  readonly userPool: UserPool;
  readonly client: UserPoolClient;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new UserPool(this, "Pool", {
      userPoolName: TEST_USER_POOL_NAME,
      // The pool uses nothing the plans above Lite add.
      featurePlan: FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      mfa: Mfa.OFF,
      accountRecovery: AccountRecovery.NONE,
      passwordPolicy: {
        minLength: MIN_PASSWORD_LENGTH,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // USER_PASSWORD_AUTH lets a machine without AWS credentials sign in with InitiateAuth. That is
    // the one way in: ADMIN_USER_PASSWORD_AUTH would add a second, through IAM, that nothing needs,
    // and SRP is for a person typing a password, which no test user has.
    this.client = this.userPool.addClient("Client", {
      userPoolClientName: TEST_USER_POOL_NAME,
      authFlows: { userPassword: true },
      disableOAuth: true,
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    Validations.of(this.userPool).acknowledge(
      {
        id: "AwsSolutions-COG2",
        reason:
          "Software signs in as a test user, with a generated password, so there is no one to give a second factor.",
      },
      {
        id: "AwsSolutions-COG8",
        reason:
          "The Plus plan's threat protection guards passwords people choose and reuse. Every password here is generated and too long to guess, and its adaptive checks would flag the same automation signing in again and again.",
      },
    );
  }
}
