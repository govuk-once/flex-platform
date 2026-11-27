import { Match, Template } from "aws-cdk-lib/assertions";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import {
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";

import { ACCOUNT, stackIn } from "../../test/cloudfront.ts";
import { cloudFrontFunctionUrl, functionUrlOrigin } from "./function-url.ts";

const DISTRIBUTIONS = `arn:aws:cloudfront::${ACCOUNT}:distribution/*`;

// A function with the URL, in the region a function is kept in.
function functionSide() {
  const { stack } = stackIn("eu-west-2");
  const fn = new LambdaFunction(stack, "Api", {
    runtime: Runtime.NODEJS_26_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
  const host = cloudFrontFunctionUrl(fn);
  return { stack, fn, host };
}

// A distribution in us-east-1 whose one origin is a function URL's host.
function distributionSide() {
  const { stack } = stackIn("us-east-1");
  new Distribution(stack, "Distribution", {
    defaultBehavior: {
      origin: functionUrlOrigin(stack, "ApiOriginAccessControl", {
        host: "abc123.lambda-url.eu-west-2.on.aws",
        originId: "api",
        originAccessControlName: "example-api",
      }),
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
    },
  });
  return { stack };
}

describe("cloudFrontFunctionUrl", () => {
  // Anything else would have Lambda run the function for whoever found the URL.
  it("gives the function a URL that takes only signed requests", () => {
    Template.fromStack(functionSide().stack).hasResourceProperties(
      "AWS::Lambda::Url",
      {
        AuthType: "AWS_IAM",
        TargetFunctionArn: {
          "Fn::GetAtt": [Match.stringLikeRegexp("^Api"), "Arn"],
        },
      },
    );
  });

  // Lambda checks both actions for a call through a URL.
  it("admits CloudFront alone, for any distribution in the function's account, and only through the URL", () => {
    const template = Template.fromStack(functionSide().stack);

    template.resourceCountIs("AWS::Lambda::Permission", 2);
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunctionUrl",
      Principal: "cloudfront.amazonaws.com",
      FunctionUrlAuthType: "AWS_IAM",
      SourceArn: DISTRIBUTIONS,
    });
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "cloudfront.amazonaws.com",
      InvokedViaFunctionUrl: true,
      SourceArn: DISTRIBUTIONS,
    });
  });

  it("gives the URL's host alone", () => {
    const { stack, host } = functionSide();
    const template = Template.fromStack(stack);
    const [urlId] = Object.keys(template.findResources("AWS::Lambda::Url"));

    expect(stack.resolve(host)).toEqual({
      "Fn::Select": [
        2,
        { "Fn::Split": ["/", { "Fn::GetAtt": [urlId, "FunctionUrl"] }] },
      ],
    });
  });

  // A new ID would replace the URL, and AWS would give it a new host.
  it("keeps its IDs in the function", () => {
    const { fn } = functionSide();

    for (const id of [
      "FunctionUrl",
      "InvokeUrlFromCloudFront",
      "InvokeFromCloudFront",
    ]) {
      expect(fn.node.tryFindChild(id), id).toBeDefined();
    }
  });
});

describe("functionUrlOrigin", () => {
  // The URL takes no unsigned request, so without this every request would be refused.
  it("signs every request, replacing any Authorization a caller sent", () => {
    Template.fromStack(distributionSide().stack).hasResourceProperties(
      "AWS::CloudFront::OriginAccessControl",
      {
        OriginAccessControlConfig: {
          Name: "example-api",
          OriginAccessControlOriginType: "lambda",
          SigningBehavior: "always",
          SigningProtocol: "sigv4",
        },
      },
    );
  });

  it("reaches the host over HTTPS and TLS 1.2, under the origin ID and access control given", () => {
    Template.fromStack(distributionSide().stack).hasResourceProperties(
      "AWS::CloudFront::Distribution",
      {
        DistributionConfig: Match.objectLike({
          Origins: [
            Match.objectLike({
              Id: "api",
              DomainName: "abc123.lambda-url.eu-west-2.on.aws",
              CustomOriginConfig: {
                OriginProtocolPolicy: "https-only",
                OriginSSLProtocols: ["TLSv1.2"],
              },
              OriginAccessControlId: {
                "Fn::GetAtt": [
                  Match.stringLikeRegexp("^ApiOriginAccessControl"),
                  "Id",
                ],
              },
            }),
          ],
        }),
      },
    );
  });

  it("keeps the access control's ID in the scope it is given", () => {
    const { stack } = distributionSide();

    expect(stack.node.tryFindChild("ApiOriginAccessControl")).toBeDefined();
  });
});
