import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  logGroupWriteStatements,
  PlatformLogGroup,
} from "@repo/infra-constructs";
import {
  buildReleaseWorker,
  RELEASE_HANDLER,
  RELEASE_TIMEOUT_SECONDS,
  type ReleaseConfig,
  type ReleaseTarget,
} from "@repo/shared-release";
import { bundleKey } from "@repo/shared-release/bundle-key";
import { Duration, Stack, Validations } from "aws-cdk-lib";
import {
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  EventSourceMapping,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Queue, QueueEncryption, RedrivePermission } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

import {
  RELEASE_DEAD_LETTER_QUEUE_NAME,
  RELEASE_QUEUE_NAME,
  RELEASE_WORKER_LOG_GROUP_NAME,
  RELEASE_WORKER_NAME,
  SHARED_REGION,
} from "./names.ts";

/**
 * The longest one attempt at a release may take. A first release creates a function in a VPC,
 * which Lambda can take minutes to make ready.
 */
export const RELEASE_TIMEOUT = Duration.seconds(RELEASE_TIMEOUT_SECONDS);

/**
 * How long the queue hides a release the worker has taken. Longer than a release may take, so no
 * release runs twice at once, and a failed one is tried again after it.
 */
export const RELEASE_VISIBILITY_TIMEOUT = Duration.minutes(20);

/**
 * How long the dead-letter queue hides a message the dead-letter worker has taken. Longer than the
 * worker may run, so a message it gives back comes again soon.
 */
export const DEAD_LETTER_VISIBILITY_TIMEOUT = Duration.minutes(2);

/** How many times a release is tried before it is moved to the dead-letter queue. */
export const RELEASE_ATTEMPTS = 3;

/**
 * How many releases run at once, each for another domain or environment. Lambda polls the queue
 * with at least two.
 */
export const RELEASE_CONCURRENCY = 2;

export interface ReleaseWorkerProps {
  /** The bucket every domain's bundles are kept in, in this stack's account and region. */
  readonly codeBucketName: string;
  /** Each domain in each environment the worker may release, and everything a release names. */
  readonly targets: readonly ReleaseTarget[];
  /** The one role that may ask for a release: the pipeline API's, by ARN. */
  readonly producerRoleArn: string;
  /** The table each release is recorded in, by the name the worker is built with and by ARN. */
  readonly releaseTable: { readonly name: string; readonly arn: string };
}

/**
 * The queue the pipeline API puts each release on, and the function that does it. The function is
 * built with what each domain's release names, so a domain it can release is one config gave it.
 *
 * The queue is FIFO, grouped by domain and environment, so one domain's releases run in the order
 * they were asked for, one at a time, while other domains' run alongside. A release that fails is
 * given back and tried again, and after a few tries is moved to the dead-letter queue.
 *
 * Its role may read a bundle, by version, and assume the deploy role of each domain it releases,
 * and nothing in a domain account itself. What a release may do there is the deploy role's to say.
 *
 * Anything in the account that IAM allows can invoke the function, and a function's policy can't
 * refuse it. So a message only names a release, which the worker reads from the release table,
 * where no role but the pipeline API's may record one. The queue's policy refuses, from anyone, a
 * message from any role but the API's, taking one by any role but the worker's, a purge, and
 * moving messages out of either queue.
 */
export class ReleaseWorker extends Construct {
  public readonly function: LambdaFunction;
  public readonly queue: Queue;
  /** Where the queue moves a release it has tried as often as it tries. */
  public readonly deadLetters: Queue;
  /** The role the worker runs as, which every deploy role it assumes trusts. */
  public readonly role: Role;

  constructor(scope: Construct, id: string, props: ReleaseWorkerProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== SHARED_REGION) {
      throw new Error(
        `The release worker runs in ${SHARED_REGION}, not ${stack.region}`,
      );
    }

    const queueArn = stack.formatArn({
      service: "sqs",
      resource: RELEASE_QUEUE_NAME,
    });
    const deadLetters = new Queue(this, "DeadLetters", {
      queueName: RELEASE_DEAD_LETTER_QUEUE_NAME,
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: DEAD_LETTER_VISIBILITY_TIMEOUT,
      // By the release queue's ARN, not the queue, which names this one: each would wait for the
      // other.
      redriveAllowPolicy: {
        redrivePermission: RedrivePermission.BY_QUEUE,
        sourceQueues: [Queue.fromQueueArn(this, "Source", queueArn)],
      },
    });
    this.deadLetters = deadLetters;
    this.queue = new Queue(this, "Queue", {
      queueName: RELEASE_QUEUE_NAME,
      fifo: true,
      // SQS's own key: a message holds only a release's key, and Lambda reads the queue with no
      // grant on a key of ours.
      encryption: QueueEncryption.SQS_MANAGED,
      // The pipeline API names each release, so asking twice for one starts one.
      contentBasedDeduplication: false,
      enforceSSL: true,
      visibilityTimeout: RELEASE_VISIBILITY_TIMEOUT,
      deadLetterQueue: {
        queue: deadLetters,
        maxReceiveCount: RELEASE_ATTEMPTS,
      },
    });
    Validations.of(deadLetters).acknowledge({
      id: "AwsSolutions-SQS3",
      reason:
        "It is the release queue's dead-letter queue. The dead-letter worker gives a message back only while it can't record the release, which an alarm on its log says, so the queue keeps it to try again.",
    });

    const { logGroup, key: logGroupKey } = new PlatformLogGroup(this, "Logs", {
      logGroupName: RELEASE_WORKER_LOG_GROUP_NAME,
    });
    const logs = logGroupWriteStatements(this, {
      logGroupName: RELEASE_WORKER_LOG_GROUP_NAME,
      logGroupKey,
    });

    const bundles = stack.formatArn({
      service: "s3",
      region: "",
      account: "",
      resource: props.codeBucketName,
      resourceName: bundleKey("*", "*"),
    });
    const deployRoles = props.targets.map(({ deployRoleArn }) => deployRoleArn);
    const role = new Role(this, "Role", {
      roleName: RELEASE_WORKER_NAME,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        Release: new PolicyDocument({
          statements: [
            ...logs.statements,
            // What Lambda needs to give the function the queue's messages, and take them back.
            new PolicyStatement({
              actions: [
                "sqs:ChangeMessageVisibility",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
                "sqs:ReceiveMessage",
              ],
              resources: [this.queue.queueArn],
            }),
            // To read each release, claim it, and record how it went.
            new PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
              resources: [props.releaseTable.arn],
            }),
            // To hash a bundle, by version, before anything is made of it.
            new PolicyStatement({
              actions: ["s3:GetObject", "s3:GetObjectVersion"],
              resources: [bundles],
            }),
            ...(deployRoles.length === 0
              ? []
              : [
                  new PolicyStatement({
                    actions: ["sts:AssumeRole"],
                    resources: deployRoles,
                  }),
                ]),
          ],
        }),
      },
    });
    this.role = role;
    this.denyAllButTheApiAndWorker(deadLetters, props.producerRoleArn);
    Validations.of(role).acknowledge(...logs.acknowledgements, {
      id: `AwsSolutions-IAM5[Resource::${bundles}]`,
      reason:
        "A bundle's key holds its domain and its hash, which no stack knows. The grant is held to keys of that shape, and to reading them.",
    });

    const config: ReleaseConfig = {
      bucket: props.codeBucketName,
      region: stack.region,
      table: props.releaseTable.name,
      targets: props.targets,
    };
    this.function = new LambdaFunction(this, "Function", {
      functionName: RELEASE_WORKER_NAME,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: RELEASE_HANDLER,
      code: Code.fromAsset(bundleDirectory(config)),
      role,
      timeout: RELEASE_TIMEOUT,
      // A bundle is hashed as it streams, so its size needs no memory to match.
      memorySize: 512,
      logGroup,
    });

    // One release at a time, so each attempt is its own, and a failed one is given back alone.
    new EventSourceMapping(this, "QueueSource", {
      target: this.function,
      eventSourceArn: this.queue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
      maxConcurrency: RELEASE_CONCURRENCY,
    });
  }

  // In the queues' policies, not the roles': a deny there holds whatever any principal's own
  // policy allows. Lambda takes the queue's messages as the worker's role.
  private denyAllButTheApiAndWorker(
    deadLetters: Queue,
    producerRoleArn: string,
  ): void {
    const deny = (
      sid: string,
      actions: string[],
      conditions?: Record<string, Record<string, string>>,
    ) =>
      new PolicyStatement({
        sid,
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions,
        resources: [this.queue.queueArn],
        ...(conditions !== undefined && { conditions }),
      });

    this.queue.addToResourcePolicy(
      deny("DenySendsButThePipelineApi", ["sqs:SendMessage"], {
        ArnNotEquals: { "aws:PrincipalArn": producerRoleArn },
      }),
    );
    this.queue.addToResourcePolicy(
      deny(
        "DenyTakingButTheWorker",
        [
          "sqs:ChangeMessageVisibility",
          "sqs:DeleteMessage",
          "sqs:ReceiveMessage",
        ],
        { ArnNotEquals: { "aws:PrincipalArn": this.role.roleArn } },
      ),
    );
    // A purge drops releases asked for, and nothing of the platform's needs one.
    this.queue.addToResourcePolicy(deny("DenyPurging", ["sqs:PurgeQueue"]));
    // SQS moves a message to the dead-letter queue itself, as no principal, so no one sends one.
    // A message sent there would be taken for a release the queue gave up on.
    deadLetters.addToResourcePolicy(
      new PolicyStatement({
        sid: "DenySending",
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["sqs:SendMessage"],
        resources: [deadLetters.queueArn],
      }),
    );
    // Nothing of the platform's moves messages, and a pipeline asks for a failed release again.
    for (const queue of [this.queue, deadLetters]) {
      queue.addToResourcePolicy(
        new PolicyStatement({
          sid: "DenyMovingMessages",
          effect: Effect.DENY,
          principals: [new AnyPrincipal()],
          actions: ["sqs:StartMessageMoveTask"],
          resources: [queue.queueArn],
        }),
      );
    }
  }
}

// The bundle is per stage, so it's built at synth, into a directory of its own for CDK to stage.
function bundleDirectory(config: ReleaseConfig): string {
  const directory = mkdtempSync(path.join(tmpdir(), "release-worker-"));
  writeFileSync(path.join(directory, "index.js"), buildReleaseWorker(config));
  return directory;
}
