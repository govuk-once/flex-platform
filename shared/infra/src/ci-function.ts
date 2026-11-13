import {
  logGroupWriteStatements,
  PlatformLogGroup,
} from "@repo/infra-constructs";
import { Duration, Fn, Stack, Validations } from "aws-cdk-lib";
import { PolicyDocument, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { CI_FUNCTION_NAME, CI_LOG_GROUP_NAME, SHARED_REGION } from "./names.ts";

/**
 * How many requests the function serves at once. Lambda answers 429 to one more, which a pipeline
 * tries again.
 */
export const CI_CONCURRENCY = 20;

// Serves nothing yet: every request that reaches it gets the answer an unknown path gets.
const HANDLER = `exports.handler = async () => ({
  statusCode: 404,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Not found", type: "client_error" }),
});
`;

/**
 * The pipeline API's function, and the URL CloudFront reaches it at.
 *
 * The URL takes only requests signed with SigV4 by a caller its policy admits, and the policy
 * admits CloudFront alone, for this account's distributions. So a request sent straight to the
 * URL is refused by Lambda before the function runs. The policy names no one distribution: the
 * distribution is in another stack, in another region, which reads this one's URL, so naming it
 * here would make each stack wait for the other.
 */
export class CiFunction extends Construct {
  public readonly function: LambdaFunction;
  /** The function URL's host, which AWS generates. */
  public readonly urlHost: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== SHARED_REGION) {
      throw new Error(
        `The pipeline API's function runs in ${SHARED_REGION}, not ${stack.region}`,
      );
    }

    const { logGroup, key: logGroupKey } = new PlatformLogGroup(this, "Logs", {
      logGroupName: CI_LOG_GROUP_NAME,
    });
    const logs = logGroupWriteStatements(this, {
      logGroupName: CI_LOG_GROUP_NAME,
      logGroupKey,
    });

    const role = new Role(this, "Role", {
      roleName: CI_FUNCTION_NAME,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        Ci: new PolicyDocument({ statements: logs.statements }),
      },
    });
    Validations.of(role).acknowledge(...logs.acknowledgements);

    this.function = new LambdaFunction(this, "Function", {
      functionName: CI_FUNCTION_NAME,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromInline(HANDLER),
      role,
      timeout: Duration.seconds(10),
      memorySize: 256,
      reservedConcurrentExecutions: CI_CONCURRENCY,
      logGroup,
    });

    const url = this.function.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
    });
    // The URL is https://<host>/.
    this.urlHost = Fn.select(2, Fn.split("/", url.url));

    // Lambda checks both actions for a call through a function URL. The second is held to calls
    // that come through the URL, so CloudFront can't invoke the function any other way.
    const cloudFront = new ServicePrincipal("cloudfront.amazonaws.com");
    const sourceArn = stack.formatArn({
      service: "cloudfront",
      region: "",
      resource: "distribution",
      resourceName: "*",
    });
    this.function.addPermission("InvokeUrlFromCloudFront", {
      principal: cloudFront,
      action: "lambda:InvokeFunctionUrl",
      functionUrlAuthType: FunctionUrlAuthType.AWS_IAM,
      sourceArn,
    });
    this.function.addPermission("InvokeFromCloudFront", {
      principal: cloudFront,
      action: "lambda:InvokeFunction",
      invokedViaFunctionUrl: true,
      sourceArn,
    });
  }
}
