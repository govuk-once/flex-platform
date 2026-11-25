import { Fn, Stack } from "aws-cdk-lib";
import {
  FunctionUrlOriginAccessControl,
  type IOrigin,
  OriginProtocolPolicy,
  OriginSslPolicy,
  Signing,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  type Function as LambdaFunction,
  FunctionUrlAuthType,
} from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

// A Lambda function that only CloudFront calls, at its function URL: one side for the function's
// stack and one for the distribution's, which may be in another region and reads the host through
// `CrossRegionParameters`. Each builds under the scope and IDs named, not in a construct of its
// own, because those IDs are a contract: a new ID replaces the URL, and AWS gives it a new host.

/**
 * Gives a function a URL that takes only requests signed with SigV4 by a caller IAM allows, and a
 * policy that admits CloudFront alone, for any distribution in the function's account. It returns
 * the URL's host, for the distribution to reach it at.
 *
 * Builds the URL as the function's `FunctionUrl`, and the policy as its `InvokeUrlFromCloudFront`
 * and `InvokeFromCloudFront`.
 *
 * A request sent straight to the URL from outside the account is refused by Lambda before the
 * function runs. In the account, as for any function, a principal whose own policy allows the call
 * can make it, so the function relies on what it checks itself, never on where a request came from.
 */
export function cloudFrontFunctionUrl(fn: LambdaFunction): string {
  const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

  // The policy names no one distribution. AWS chooses a distribution's ID, and a distribution
  // needs this URL's host before it can be created, so naming it here would make each wait for
  // the other.
  const cloudFront = new ServicePrincipal("cloudfront.amazonaws.com");
  const sourceArn = Stack.of(fn).formatArn({
    service: "cloudfront",
    region: "",
    resource: "distribution",
    resourceName: "*",
  });

  // Lambda checks both actions for a call through a function URL. The second is held to calls
  // that come through the URL, so CloudFront can't invoke the function any other way.
  fn.addPermission("InvokeUrlFromCloudFront", {
    principal: cloudFront,
    action: "lambda:InvokeFunctionUrl",
    functionUrlAuthType: FunctionUrlAuthType.AWS_IAM,
    sourceArn,
  });
  fn.addPermission("InvokeFromCloudFront", {
    principal: cloudFront,
    action: "lambda:InvokeFunction",
    invokedViaFunctionUrl: true,
    sourceArn,
  });

  // The URL is https://<host>/.
  return Fn.select(2, Fn.split("/", url.url));
}

export interface FunctionUrlOriginProps {
  /** The host of a URL made by `cloudFrontFunctionUrl`. */
  readonly host: string;
  /** The origin's ID in the distribution, named, since CDK's default is built from the stack's name. */
  readonly originId: string;
  readonly originAccessControlName: string;
}

/**
 * The origin for a function URL made by `cloudFrontFunctionUrl`, reached over HTTPS and TLS 1.2,
 * with an origin access control, built as `id`, that signs every request. It always signs,
 * replacing any `Authorization` header a caller sent with CloudFront's own, because the URL takes
 * no unsigned request.
 */
export function functionUrlOrigin(
  scope: Construct,
  id: string,
  { host, originId, originAccessControlName }: FunctionUrlOriginProps,
): IOrigin {
  const originAccessControl = new FunctionUrlOriginAccessControl(scope, id, {
    originAccessControlName,
    signing: Signing.SIGV4_ALWAYS,
  });
  return new HttpOrigin(host, {
    originId,
    originAccessControlId: originAccessControl.originAccessControlId,
    protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
    originSslProtocols: [OriginSslPolicy.TLS_V1_2],
  });
}
