import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ReleaseTarget } from "@repo/shared-release";
import { Match, Template } from "aws-cdk-lib/assertions";
import { assert, describe, expect, it } from "vitest";

import { ACCOUNT, appOf, stackIn } from "../test/helpers.ts";
import {
  RELEASE_ATTEMPTS,
  ReleaseWorker,
  type ReleaseWorkerProps,
} from "./release-worker.ts";

const BUCKET = `shared-domain-code-${ACCOUNT}`;

const TARGET: ReleaseTarget = {
  environment: "development",
  domain: "example",
  deployRoleArn:
    "arn:aws:iam::200000000001:role/domain-development-example-deploy",
  functionName: "domain-development-example",
  executionRoleArn:
    "arn:aws:iam::200000000001:role/domain-development-example-execution",
  logGroupName: "/flex/domain/development/example/function",
  subnetIdsParameter: "/flex/network/development/isolated-subnet-ids",
  securityGroupIdParameter: "/flex/network/development/security-group/domain",
};

const PRODUCER = `arn:aws:iam::${ACCOUNT}:role/shared-ci`;

const TABLE_ARN = `arn:aws:dynamodb:eu-west-2:${ACCOUNT}:table/shared-releases`;

const PROPS: ReleaseWorkerProps = {
  codeBucketName: BUCKET,
  targets: [TARGET],
  producerRoleArn: PRODUCER,
  releaseTable: { name: "shared-releases", arn: TABLE_ARN },
};

// The statements of the named queue's policy.
function queueStatements(built: Template, queueName: string) {
  const [queueId] = Object.keys(
    built.findResources("AWS::SQS::Queue", {
      Properties: { QueueName: queueName },
    }),
  );
  assert(queueId !== undefined);
  const [policy] = Object.values(
    built.findResources("AWS::SQS::QueuePolicy", {
      Properties: { Queues: [{ Ref: queueId }] },
    }),
  );
  return (
    policy?.Properties as {
      PolicyDocument: { Statement: Record<string, unknown>[] };
    }
  ).PolicyDocument.Statement;
}

function build(region = "eu-west-2", nag = false, props = PROPS) {
  const stack = stackIn(region, nag);
  const worker = new ReleaseWorker(stack, "Release", props);
  return { stack, worker };
}

function template(props = PROPS): Template {
  return Template.fromStack(build("eu-west-2", false, props).stack);
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

// The statements of the role's one policy, which it holds inline.
function roleStatements(built: Template) {
  const [role] = Object.values(built.findResources("AWS::IAM::Role"));
  return (
    role?.Properties as {
      Policies: {
        PolicyDocument: {
          Statement: { Action: string | string[]; Resource: unknown }[];
        };
      }[];
    }
  ).Policies.flatMap(({ PolicyDocument }) => PolicyDocument.Statement);
}

describe("ReleaseWorker", () => {
  it("refuses any region but the shared account's", () => {
    expect(() => build("us-east-1")).toThrow("runs in eu-west-2");
  });

  it("passes cdk-nag and the platform's log group check", () => {
    expect(() => appOf(build("eu-west-2", true).stack).synth()).not.toThrow();
  });

  it("takes releases from a FIFO queue, moving one that fails a few times aside", () => {
    const built = template();

    built.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "shared-release.fifo",
      FifoQueue: true,
      SqsManagedSseEnabled: true,
      ContentBasedDeduplication: false,
      VisibilityTimeout: 1200,
      RedrivePolicy: {
        deadLetterTargetArn: {
          "Fn::GetAtt": [Match.stringLikeRegexp("^ReleaseDeadLetters"), "Arn"],
        },
        maxReceiveCount: RELEASE_ATTEMPTS,
      },
    });
    built.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "shared-release-dead-letter.fifo",
      FifoQueue: true,
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
      VisibilityTimeout: 120,
    });
  });

  // A deny in the queue's policy holds whatever a principal's own policy allows.
  it("refuses, from anyone, a release sent by any role but the pipeline API's, or taken by any but the worker's", () => {
    const built = template();
    const [roleId] = Object.keys(built.findResources("AWS::IAM::Role"));

    expect(queueStatements(built, "shared-release.fifo")).toEqual(
      expect.arrayContaining([
        {
          Sid: "DenySendsButThePipelineApi",
          Effect: "Deny",
          Principal: { AWS: "*" },
          Action: "sqs:SendMessage",
          Resource: expect.anything() as unknown,
          Condition: { ArnNotEquals: { "aws:PrincipalArn": PRODUCER } },
        },
        {
          Sid: "DenyTakingButTheWorker",
          Effect: "Deny",
          Principal: { AWS: "*" },
          Action: [
            "sqs:ChangeMessageVisibility",
            "sqs:DeleteMessage",
            "sqs:ReceiveMessage",
          ],
          Resource: expect.anything() as unknown,
          Condition: {
            ArnNotEquals: {
              "aws:PrincipalArn": { "Fn::GetAtt": [roleId, "Arn"] },
            },
          },
        },
      ]),
    );
  });

  // A purge drops releases asked for. A message sent to the dead-letter queue would be taken for a
  // release the queue gave up on.
  it("refuses, from anyone, a purge, moving messages out of either queue, and sending one to the dead-letter queue", () => {
    const built = template();
    const denied = (queueName: string) =>
      queueStatements(built, queueName)
        .filter(({ Effect, Condition }) => Effect === "Deny" && !Condition)
        .map(({ Action }) => Action);

    expect(denied("shared-release.fifo")).toEqual([
      "sqs:PurgeQueue",
      "sqs:StartMessageMoveTask",
    ]);
    expect(denied("shared-release-dead-letter.fifo")).toEqual([
      "sqs:SendMessage",
      "sqs:StartMessageMoveTask",
    ]);
  });

  it("lets only the release queue use the dead-letter queue", () => {
    template().hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "shared-release-dead-letter.fifo",
      RedriveAllowPolicy: {
        redrivePermission: "byQueue",
        sourceQueueArns: [
          `arn:aws:sqs:eu-west-2:${ACCOUNT}:shared-release.fifo`,
        ],
      },
    });
  });

  it("refuses to take a message over anything but TLS", () => {
    template().resourcePropertiesCountIs(
      "AWS::SQS::QueuePolicy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        },
      },
      2,
    );
  });

  it("runs one release at a time per call, giving back only the one that failed", () => {
    template().hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("^ReleaseQueue"), "Arn"],
      },
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 2 },
    });
  });

  it("is named from the shared account's names, with time for a function to become ready", () => {
    const built = template();

    built.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "shared-release-worker",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Timeout: 900,
      LoggingConfig: {
        LogGroup: { Ref: Match.stringLikeRegexp("^ReleaseLogs") },
      },
    });
    built.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      Properties: { LogGroupName: "/flex/shared/release-worker" },
    });
  });

  it("may take the queue's messages, read and change a release, read a bundle and assume each deploy role it releases with, and nothing else", () => {
    const built = template();

    built.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "shared-release-worker",
      ManagedPolicyArns: Match.absent(),
    });
    built.resourceCountIs("AWS::IAM::Policy", 0);
    expect(
      roleStatements(built).map(({ Action, Resource }) => [Action, Resource]),
    ).toEqual([
      [
        ["logs:CreateLogStream", "logs:PutLogEvents"],
        `arn:aws:logs:eu-west-2:${ACCOUNT}:log-group:/flex/shared/release-worker:*`,
      ],
      [["kms:Encrypt", "kms:GenerateDataKey*"], expect.anything()],
      [
        [
          "sqs:ChangeMessageVisibility",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ReceiveMessage",
        ],
        { "Fn::GetAtt": [expect.stringMatching(/^ReleaseQueue/), "Arn"] },
      ],
      [["dynamodb:GetItem", "dynamodb:UpdateItem"], TABLE_ARN],
      [
        ["s3:GetObject", "s3:GetObjectVersion"],
        `arn:aws:s3:::${BUCKET}/*/bundle/*.zip`,
      ],
      ["sts:AssumeRole", TARGET.deployRoleArn],
    ]);
  });

  it("assumes no role when it releases nothing", () => {
    const actions = roleStatements(template({ ...PROPS, targets: [] })).map(
      ({ Action }) => Action,
    );

    expect(actions).not.toContain("sts:AssumeRole");
  });

  // What a release names is in the code itself, so it changes only with a deploy.
  it("is built with the bucket and each target", () => {
    const code = bundle();

    expect(code).toContain(`bucket: "${BUCKET}"`);
    expect(code).toContain(`deployRoleArn: "${TARGET.deployRoleArn}"`);
    expect(code).toContain(`functionName: "${TARGET.functionName}"`);
    expect(code).toContain('table: "shared-releases"');
  });
});
