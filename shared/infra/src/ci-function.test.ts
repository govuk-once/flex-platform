import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Match, Template } from "aws-cdk-lib/assertions";
import { assert, describe, expect, it } from "vitest";

import { ACCOUNT, appOf, stackIn, ZONE } from "../test/helpers.ts";
import {
  CI_CONCURRENCY,
  CiFunction,
  type CiFunctionProps,
} from "./ci-function.ts";

const BUCKET = `shared-domain-code-${ACCOUNT}`;

const PROPS: CiFunctionProps = {
  zoneName: ZONE.zoneName,
  codeBucketName: BUCKET,
  environments: [
    { name: "development", publishes: true, domains: ["example"] },
  ],
  domains: [
    { name: "example", repositoryId: "700000001", ownerId: "90000001" },
  ],
};

function build(region = "eu-west-2", nag = false, props = PROPS) {
  const stack = stackIn(region, nag);
  const ci = new CiFunction(stack, "Ci", props);
  return { stack, ci };
}

// The function's code as CDK staged it for upload: the one asset of the stack.
function bundle(): string {
  const { directory } = appOf(build().stack).synth();
  const [asset] = readdirSync(directory).filter((name) =>
    name.startsWith("asset."),
  );
  assert(asset !== undefined);
  return readFileSync(path.join(directory, asset, "index.js"), "utf8");
}

function template(): Template {
  return Template.fromStack(build().stack);
}

const DISTRIBUTIONS = `arn:aws:cloudfront::${ACCOUNT}:distribution/*`;

describe("CiFunction", () => {
  it("refuses any region but the shared account's", () => {
    expect(() => build("us-east-1")).toThrow("runs in eu-west-2");
  });

  it("passes cdk-nag and the platform's log group check", () => {
    expect(() => appOf(build("eu-west-2", true).stack).synth()).not.toThrow();
  });

  it("is named from the shared account's names, with a short timeout and few copies at once", () => {
    template().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "shared-ci",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Timeout: 10,
      MemorySize: 1769,
      ReservedConcurrentExecutions: CI_CONCURRENCY,
    });
  });

  it("logs to a log group of the platform's, by its name", () => {
    const built = template();

    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: { LogGroupName: "/flex/shared/ci", RetentionInDays: 365 },
    });
    built.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp("^CiLogs") } },
    });
  });

  // No managed policy, which would let it create a log group.
  it("runs as a role that may only write to its own log group and upload a bundle", () => {
    const built = template();

    built.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "shared-ci",
      ManagedPolicyArns: Match.absent(),
    });
    const [role] = Object.values(built.findResources("AWS::IAM::Role"));
    const statements = (
      role?.Properties as {
        Policies: {
          PolicyDocument: { Statement: { Action: string | string[] }[] };
        }[];
      }
    ).Policies.flatMap(({ PolicyDocument }) => PolicyDocument.Statement);

    expect(statements.flatMap(({ Action }) => Action)).toEqual([
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "s3:PutObject",
    ]);
    built.resourceCountIs("AWS::IAM::Policy", 0);
  });

  // The signature on an upload carries the role's permission and no more, so this is the most
  // any upload can do: write a key shaped like a bundle's. Not read, list or delete.
  it("may write only keys shaped like a bundle's, in the code bucket", () => {
    template().hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: "s3:PutObject",
                Resource: `arn:aws:s3:::${BUCKET}/*/bundle/*.zip`,
              },
            ]),
          },
        },
      ],
    });
  });

  // Anything else would have Lambda run the function for whoever found the URL.
  it("has a URL that takes only signed requests", () => {
    template().hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "AWS_IAM",
      TargetFunctionArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("^CiFunction"), "Arn"],
      },
    });
  });

  // Lambda checks both actions for a call through a URL.
  it("has a policy that admits CloudFront alone, for this account's distributions, and only through the URL", () => {
    const built = template();

    built.resourceCountIs("AWS::Lambda::Permission", 2);
    built.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunctionUrl",
      Principal: "cloudfront.amazonaws.com",
      FunctionUrlAuthType: "AWS_IAM",
      SourceArn: DISTRIBUTIONS,
    });
    built.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "cloudfront.amazonaws.com",
      InvokedViaFunctionUrl: true,
      SourceArn: DISTRIBUTIONS,
    });
  });

  it("gives the URL's host alone, for the distribution to reach it at", () => {
    const { stack, ci } = build();
    const [urlId] = Object.keys(
      Template.fromStack(stack).findResources("AWS::Lambda::Url"),
    );

    expect(stack.resolve(ci.urlHost)).toEqual({
      "Fn::Select": [
        2,
        { "Fn::Split": ["/", { "Fn::GetAtt": [urlId, "FunctionUrl"] }] },
      ],
    });
  });

  it("runs the pipeline API's bundle, staged as an asset", () => {
    template().hasResourceProperties("AWS::Lambda::Function", {
      Code: { S3Key: Match.stringLikeRegexp(String.raw`\.zip$`) },
    });
  });

  // Who may release what is in the code itself, so it changes only with a deploy.
  it("is built with GitHub as the issuer, its own address as the audience, and each domain's repository", () => {
    const code = bundle();

    expect(code).toContain('"https://token.actions.githubusercontent.com"');
    expect(code).toContain(
      '"https://token.actions.githubusercontent.com/.well-known/jwks"',
    );
    expect(code).toContain(`"https://${ZONE.zoneName}/ci"`);
    expect(code).toContain('repositoryId: "700000001"');
    expect(code).toContain('ownerId: "90000001"');
  });

  it("is built with the bucket uploads go to, in its own region, and where pipelines upload", () => {
    const code = bundle();

    expect(code).toContain(`bucket: "${BUCKET}"`);
    expect(code).toContain('region: "eu-west-2"');
    expect(code).toContain("publishes: true");
  });

  it("refuses to build with a repository that isn't given by GitHub's IDs", () => {
    expect(() =>
      build("eu-west-2", false, {
        ...PROPS,
        domains: [
          { name: "example", repositoryId: "example-org/x", ownerId: "1" },
        ],
      }),
    ).toThrow("GitHub's IDs");
  });
});
