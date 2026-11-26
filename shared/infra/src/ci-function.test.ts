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

const QUEUE_URL = `https://sqs.eu-west-2.amazonaws.com/${ACCOUNT}/shared-release.fifo`;

const QUEUE_ARN = `arn:aws:sqs:eu-west-2:${ACCOUNT}:shared-release.fifo`;

const TABLE_ARN = `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/shared-releases`;

const ARTEFACT_TABLE_ARN = `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/shared-release-artefacts`;

const PROPS: CiFunctionProps = {
  zoneName: ZONE.zoneName,
  codeBucketName: BUCKET,
  environments: [
    { name: "development", publishes: true, domains: ["example"] },
  ],
  domains: [
    { name: "example", repositoryId: "700000001", ownerId: "90000001" },
  ],
  releaseQueue: { url: QUEUE_URL, arn: QUEUE_ARN },
  releaseTable: { name: "shared-releases", arn: TABLE_ARN },
  artefactTable: { name: "shared-release-artefacts", arn: ARTEFACT_TABLE_ARN },
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

describe("CiFunction", () => {
  it("refuses any region but the shared account's", () => {
    expect(() => build("us-east-1")).toThrow("runs in eu-west-2");
  });

  it("passes cdk-nag and the platform's log group check", () => {
    expect(() => appOf(build("eu-west-2", true).stack).synth()).not.toThrow();
  });

  it("is named from the shared account's names, with a short timeout and few copies at once", () => {
    const template = Template.fromStack(build().stack);

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "shared-ci",
      Runtime: "nodejs26.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Timeout: 10,
      MemorySize: 1769,
      ReservedConcurrentExecutions: CI_CONCURRENCY,
    });
  });

  it("logs to a log group of the platform's, by its name", () => {
    const built = Template.fromStack(build().stack);

    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: { LogGroupName: "/flex/shared/ci", RetentionInDays: 365 },
    });
    built.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp("^CiLogs") } },
    });
  });

  // No managed policy, which would let it create a log group.
  it("runs as a role that may only write to its own log group, upload a bundle and ask for a release", () => {
    const built = Template.fromStack(build().stack);

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
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListBucket",
      "sqs:SendMessage",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]);
    built.resourceCountIs("AWS::IAM::Policy", 0);
  });

  // The signature on an upload carries the role's permission and no more, so this is the most
  // any upload can do: write a key shaped like a bundle's. Never delete.
  it("may write and read only keys shaped like a bundle's, in the code bucket, and list it", () => {
    const template = Template.fromStack(build().stack);

    template.hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject"],
                Resource: `arn:aws:s3:::${BUCKET}/*/bundle/*.zip`,
              },
              {
                Effect: "Allow",
                Action: "s3:ListBucket",
                Resource: `arn:aws:s3:::${BUCKET}`,
              },
            ]),
          },
        },
      ],
    });
  });

  it("may record a release in the release table, change one and read one, and in no other table", () => {
    const template = Template.fromStack(build().stack);

    template.hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: [
                  "dynamodb:GetItem",
                  "dynamodb:PutItem",
                  "dynamodb:UpdateItem",
                ],
                Resource: TABLE_ARN,
              },
            ]),
          },
        },
      ],
    });
  });

  // A version is recorded once, where there is none, and never changed.
  it("may record a version in the artefacts table, and read one, and never change one", () => {
    const template = Template.fromStack(build().stack);

    template.hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
                Resource: ARTEFACT_TABLE_ARN,
              },
            ]),
          },
        },
      ],
    });
  });

  it("may put a release on the release queue, and on no other", () => {
    const template = Template.fromStack(build().stack);

    template.hasResourceProperties("AWS::IAM::Role", {
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: "sqs:SendMessage",
                Resource: QUEUE_ARN,
              },
            ]),
          },
        },
      ],
    });
  });

  // What the URL admits is `cloudFrontFunctionUrl`'s, and tested with it.
  it("has one URL, for its own function, and gives that URL's host", () => {
    const { stack, ci } = build();
    const built = Template.fromStack(stack);
    const [urlId] = Object.keys(built.findResources("AWS::Lambda::Url"));

    built.resourceCountIs("AWS::Lambda::Url", 1);
    built.hasResourceProperties("AWS::Lambda::Url", {
      TargetFunctionArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("^CiFunction"), "Arn"],
      },
    });
    built.resourceCountIs("AWS::Lambda::Permission", 2);
    expect(stack.resolve(ci.urlHost)).toEqual({
      "Fn::Select": [
        2,
        { "Fn::Split": ["/", { "Fn::GetAtt": [urlId, "FunctionUrl"] }] },
      ],
    });
  });

  it("runs the pipeline API's bundle, staged as an asset", () => {
    const template = Template.fromStack(build().stack);

    template.hasResourceProperties("AWS::Lambda::Function", {
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

  it("is built with the bucket uploads go to, in its own region, where pipelines upload, and the release queue", () => {
    const code = bundle();

    expect(code).toContain(`bucket: "${BUCKET}"`);
    expect(code).toContain('region: "eu-west-2"');
    expect(code).toContain("publishes: true");
    expect(code).toContain(`queueUrl: "${QUEUE_URL}"`);
    expect(code).toContain('table: "shared-releases"');
    expect(code).toContain('table: "shared-release-artefacts"');
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
