import { readFileSync } from "node:fs";
import path from "node:path";

import { deployRoleName } from "@repo/domain-infra";
import { cdkApp } from "@repo/infra-constructs";
import { MANAGEMENT_REGION, SHARED_REGION } from "@repo/shared-infra";
import { Match, Template } from "aws-cdk-lib/assertions";
import { assert, describe, expect, it } from "vitest";

import {
  FIXTURE_STAGES,
  REPOSITORY,
  synthesizedStage,
} from "../../test/helpers.ts";
import { inventory } from "../inventory.ts";
import {
  SHARED_RELEASE_STACK_NAME,
  SharedReleaseStack,
} from "./shared-release.ts";

const [, , PROD] = FIXTURE_STAGES;

function template(): Template {
  return Template.fromStack(new SharedReleaseStack(cdkApp(), PROD));
}

// The function's code as CDK staged it for upload, found by the key the function names.
function bundle(): string {
  const app = cdkApp();
  const stack = new SharedReleaseStack(app, PROD);
  const { directory } = app.synth();
  const [fn] = Object.values(
    Template.fromStack(stack).findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: "shared-ci" },
    }),
  );
  const key = (fn?.Properties as { Code: { S3Key: string } }).Code.S3Key;
  return readFileSync(
    path.join(directory, `asset.${key.replace(/\.zip$/, "")}`, "index.js"),
    "utf8",
  );
}

describe("SharedReleaseStack", () => {
  // Every stage has the pipeline API, so the stacks are the same in each.
  it.each(FIXTURE_STAGES)("is built in $name", (stage) => {
    expect(
      synthesizedStage(stage).stacks.map((stack) => stack.stackName),
    ).toContain(SHARED_RELEASE_STACK_NAME);
  });

  it("is in the stage's shared account, in its region, protected from deletion", () => {
    const stack = new SharedReleaseStack(cdkApp(), PROD);

    expect(stack.stackName).toBe("shared-release");
    expect(stack.account).toBe(PROD.shared.account);
    expect(stack.region).toBe(SHARED_REGION);
    expect(stack.terminationProtection).toBe(true);
  });

  // It holds what the distribution reads, so it deploys first and waits for nothing.
  it("depends on no stack", () => {
    const stack = inventory(synthesizedStage(PROD)).find(
      ({ name }) => name === SHARED_RELEASE_STACK_NAME,
    );

    assert(stack !== undefined);
    expect(stack.dependencies).toEqual([]);
  });

  it("holds the pipeline API's function and its URL, and reads nothing", () => {
    const built = template();

    built.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "shared-ci",
    });
    built.resourceCountIs("AWS::Lambda::Url", 1);
    const { Parameters } = built.toJSON() as {
      Parameters: Record<string, unknown>;
    };
    expect(Object.keys(Parameters)).toEqual(["BootstrapVersion"]);
  });

  // The registry is the stage's config, so a domain's repository changes by a deploy of this stack.
  it("builds the function with the stage's audience, environments, and each domain that has a repository", () => {
    const code = bundle();

    expect(code).toContain(`"https://${PROD.shared.zone.name}/ci"`);
    for (const environment of PROD.environments) {
      expect(code).toContain(`name: "${environment.name}"`);
    }
    expect(code).toContain(`repositoryId: "${REPOSITORY.id}"`);
    expect(code).toContain(`ownerId: "${REPOSITORY.ownerId}"`);
    // Hosted, but with no repository yet: listed under its environments, never registered.
    expect(code).toContain('"domain-b"');
    expect(code).not.toContain('name: "domain-b"');
    // The repository's name is a label. Nothing checks it, so the function doesn't hold it.
    expect(code).not.toContain(REPOSITORY.name);
  });

  it("holds the release queue and the worker that takes from it", () => {
    const built = template();

    built.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "shared-release.fifo",
    });
    built.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "shared-release-worker",
    });
  });

  // The address the function is built with is the queue's, or a release would go nowhere.
  it("builds the function with the release queue's address, and lets its role send only there", () => {
    const built = template();
    const [queueId] = Object.keys(
      built.findResources("AWS::SQS::Queue", {
        Properties: { QueueName: "shared-release.fifo" },
      }),
    );
    assert(queueId !== undefined);

    expect(bundle()).toContain(
      `queueUrl: "https://sqs.${SHARED_REGION}.amazonaws.com/${PROD.shared.account}/shared-release.fifo"`,
    );
    built.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "shared-ci",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: "sqs:SendMessage",
                Resource: { "Fn::GetAtt": [queueId, "Arn"] },
              },
            ]),
          },
        },
      ],
    });
  });

  // The roles the table and the queue name are the ones the functions run as.
  it("lets the function's role, and no other, record a release and send it, and the workers' change it", () => {
    const built = template();
    const role = `arn:aws:iam::${PROD.shared.account}:role/shared-ci`;
    const worker = `arn:aws:iam::${PROD.shared.account}:role/shared-release-worker`;
    const deadLetterWorker = `arn:aws:iam::${PROD.shared.account}:role/shared-release-dead-letter-worker`;

    built.hasResourceProperties("AWS::IAM::Role", { RoleName: "shared-ci" });
    built.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "shared-release-worker",
    });
    built.hasResourceProperties("AWS::DynamoDB::Table", {
      ResourcePolicy: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: "DenyRecordingButThePipelineApi",
              Condition: { ArnNotEquals: { "aws:PrincipalArn": [role] } },
            }),
            Match.objectLike({
              Sid: "DenyChangingButTheApiAndWorker",
              Condition: {
                ArnNotEquals: {
                  "aws:PrincipalArn": [role, worker, deadLetterWorker],
                },
              },
            }),
          ]),
        },
      },
    });
    built.hasResourceProperties("AWS::SQS::QueuePolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "DenySendsButThePipelineApi",
            Condition: { ArnNotEquals: { "aws:PrincipalArn": role } },
          }),
        ]),
      },
    });
    expect(bundle()).toContain('table: "shared-releases"');
  });

  // The role the table lets give a release up is the one the dead-letter worker runs as.
  it("gives up, by its own function, each release the queue moves to the dead-letter queue", () => {
    const built = template();

    built.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "shared-release-dead-letter-worker",
    });
    built.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: {
        "Fn::GetAtt": [Match.stringLikeRegexp("^ReleaseDeadLetters"), "Arn"],
      },
      FunctionName: {
        Ref: Match.stringLikeRegexp("^DeadLetterWorkerFunction"),
      },
    });
  });

  // The worker releases only where a pipeline publishes. Elsewhere code will arrive by promotion.
  // Only a domain with a repository can be released, so no other's deploy role is assumed.
  it("lets the worker assume the deploy role of each registered domain where a pipeline publishes, and no other", () => {
    const [dev] = PROD.environments;
    const [main] = dev.domainAccounts;

    template().hasResourceProperties("AWS::IAM::Role", {
      RoleName: "shared-release-worker",
      Policies: [
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Effect: "Allow",
                Action: "sts:AssumeRole",
                Resource: `arn:aws:iam::${main.account}:role/domain-dev-domain-a-deploy`,
              },
            ]),
          },
        },
      ],
    });
  });

  it("lets Lambda read a bundle for the domain functions of each account where a pipeline publishes", () => {
    const [dev] = PROD.environments;
    const policy = JSON.stringify(
      template().findResources("AWS::S3::BucketPolicy"),
    );

    for (const { account } of dev.domainAccounts) {
      expect(policy).toContain(
        `arn:aws:lambda:${SHARED_REGION}:${account}:function:domain-dev-*`,
      );
    }
    for (const environment of PROD.environments.slice(1)) {
      expect(policy).not.toContain(`function:domain-${environment.name}-`);
    }
  });

  // The names the domain stacks give their deploy roles, so Lambda can read a bundle as one.
  it("lets the deploy roles of each account where a pipeline publishes read a bundle", () => {
    const [dev] = PROD.environments;
    const policy = JSON.stringify(
      template().findResources("AWS::S3::BucketPolicy"),
    );

    for (const { account } of dev.domainAccounts) {
      expect(policy).toContain(
        `arn:aws:iam::${account}:role/${deployRoleName("dev", "*")}`,
      );
    }
    for (const environment of PROD.environments.slice(1)) {
      expect(policy).not.toContain(`role/domain-${environment.name}-`);
    }
  });

  it("holds the bucket a domain's code is uploaded to, named for the shared account", () => {
    template().hasResourceProperties("AWS::S3::Bucket", {
      BucketName: `shared-domain-code-${PROD.shared.account}`,
    });
  });

  // The same name in both, or the function would sign uploads to a bucket that isn't there.
  it("builds the function with that bucket, and lets its role upload only there", () => {
    const name = `shared-domain-code-${PROD.shared.account}`;

    expect(bundle()).toContain(`bucket: "${name}"`);
    expect(bundle()).toContain(`region: "${SHARED_REGION}"`);
    expect(
      JSON.stringify(template().findResources("AWS::IAM::Role")),
    ).toContain(`:s3:::${name}/*/bundle/*.zip`);
  });

  // The role that signs uploads, so a signed upload is the only write the bucket takes.
  it("lets the function's role, and no other, write to the bucket", () => {
    const built = template();
    const [roleId] = Object.keys(
      built.findResources("AWS::IAM::Role", {
        Properties: { RoleName: "shared-ci" },
      }),
    );
    assert(roleId !== undefined);

    built.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "DenyWritesButThePipelineApi",
            Condition: {
              ArnNotEquals: {
                "aws:PrincipalArn": { "Fn::GetAtt": [roleId, "Arn"] },
              },
            },
          }),
        ]),
      },
    });
  });

  // Code enters the stage only where an environment publishes.
  it("builds the function with which environments take an upload", () => {
    const code = bundle();

    for (const environment of PROD.environments) {
      const publishes = environment.release === "publish";
      expect(code).toMatch(
        new RegExp(
          String.raw`name: "${environment.name}",\s+publishes: ${String(publishes)}`,
        ),
      );
    }
    expect(
      PROD.environments.map(({ release }) => release === "publish"),
    ).toEqual([true, false, false]);
  });

  // AWS generates the host, and the distribution's stack is in another region, where
  // CloudFormation can write no parameter for this one.
  it("writes the URL's host to the distribution's region, for its stack to read", () => {
    const built = template();
    const [urlId] = Object.keys(built.findResources("AWS::Lambda::Url"));
    const [writer] = Object.values(
      built.findResources("Custom::CrossRegionParameter"),
    );
    assert(writer !== undefined);

    built.resourceCountIs("Custom::CrossRegionParameter", 1);
    const create = JSON.stringify(
      (writer.Properties as Record<string, unknown>).Create,
    );
    expect(create).toContain("/flex/cross-region/shared/ci-origin-host");
    expect(create).toContain(String.raw`\"region\":\"${MANAGEMENT_REGION}\"`);
    // The host alone: the third part of https://<host>/.
    expect(create).toContain(
      JSON.stringify({
        "Fn::Select": [
          2,
          { "Fn::Split": ["/", { "Fn::GetAtt": [urlId, "FunctionUrl"] }] },
        ],
      }),
    );
  });

  // CDK would run the writer in a function with a log group of its own, which nothing accounts for.
  it("logs the writer to a log group of the platform's", () => {
    template().hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/flex/shared/cross-region-writer",
      RetentionInDays: 365,
    });
  });
});
