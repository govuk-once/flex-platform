import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  logGroupWriteStatements,
  PlatformLogGroup,
} from "@repo/infra-constructs";
import {
  buildDeadLetterWorker,
  type DeadLetterConfig,
  RELEASE_HANDLER,
} from "@repo/shared-release";
import { Duration, Stack, Validations } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
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
import {
  FilterPattern,
  type ILogGroup,
  MetricFilter,
} from "aws-cdk-lib/aws-logs";
import type { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

import {
  RELEASE_DEAD_LETTER_WORKER_LOG_GROUP_NAME,
  RELEASE_DEAD_LETTER_WORKER_NAME,
  RELEASE_METRIC_NAMESPACE,
} from "./names.ts";
import { RELEASE_WORKER_ACTIONS } from "./release-table.ts";

/** How long the dead-letter worker may take over one message: one read and one write. */
export const DEAD_LETTER_WORKER_TIMEOUT = Duration.seconds(30);

const ALARM_PERIOD = Duration.minutes(5);

export interface ReleaseDeadLetterWorkerProps {
  /** The release queue's dead-letter queue, which the worker reads. */
  readonly deadLetters: Queue;
  /** The release table, by the name the worker is built with and by ARN. */
  readonly releaseTable: { readonly name: string; readonly arn: string };
}

/**
 * Gives up each release whose message the release queue moved to its dead-letter queue, so the
 * release table says no more attempts are coming. A function of its own, not the release worker:
 * Lambda holds a queue's visibility timeout to at least its reader's timeout, which is the
 * worker's 15 minutes, and this one needs none of the worker's access to bundles or domain
 * accounts. Its role may take the dead-letter queue's messages and change a release, and nothing
 * else, and the queue's policy lets no other role take one.
 *
 * Two alarms on its log, with no action until the platform has alerting: a release given up, and
 * a message it couldn't record, which goes round the dead-letter queue until it can or the queue
 * drops it.
 */
export class ReleaseDeadLetterWorker extends Construct {
  public readonly function: LambdaFunction;
  public readonly role: Role;
  /** A release was given up. */
  public readonly abandoned: Alarm;
  /** A release couldn't be recorded as given up. */
  public readonly failed: Alarm;

  constructor(
    scope: Construct,
    id: string,
    props: ReleaseDeadLetterWorkerProps,
  ) {
    super(scope, id);

    const { deadLetters } = props;
    const { logGroup, key: logGroupKey } = new PlatformLogGroup(this, "Logs", {
      logGroupName: RELEASE_DEAD_LETTER_WORKER_LOG_GROUP_NAME,
    });
    const logs = logGroupWriteStatements(this, {
      logGroupName: RELEASE_DEAD_LETTER_WORKER_LOG_GROUP_NAME,
      logGroupKey,
    });

    this.role = new Role(this, "Role", {
      roleName: RELEASE_DEAD_LETTER_WORKER_NAME,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        DeadLetters: new PolicyDocument({
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
              resources: [deadLetters.queueArn],
            }),
            // To read a release, and give it up.
            new PolicyStatement({
              actions: RELEASE_WORKER_ACTIONS,
              resources: [props.releaseTable.arn],
            }),
          ],
        }),
      },
    });
    Validations.of(this.role).acknowledge(...logs.acknowledgements);

    // In the queue's policy: a deny there holds whatever any principal's own policy allows.
    deadLetters.addToResourcePolicy(
      new PolicyStatement({
        sid: "DenyTakingButTheDeadLetterWorker",
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: [
          "sqs:ChangeMessageVisibility",
          "sqs:DeleteMessage",
          "sqs:ReceiveMessage",
        ],
        resources: [deadLetters.queueArn],
        conditions: {
          ArnNotEquals: { "aws:PrincipalArn": this.role.roleArn },
        },
      }),
    );

    const config: DeadLetterConfig = {
      region: Stack.of(this).region,
      table: props.releaseTable.name,
    };
    this.function = new LambdaFunction(this, "Function", {
      functionName: RELEASE_DEAD_LETTER_WORKER_NAME,
      runtime: Runtime.NODEJS_26_X,
      architecture: Architecture.ARM_64,
      handler: RELEASE_HANDLER,
      code: Code.fromAsset(bundleDirectory(config)),
      role: this.role,
      timeout: DEAD_LETTER_WORKER_TIMEOUT,
      memorySize: 256,
      logGroup,
    });
    new EventSourceMapping(this, "QueueSource", {
      target: this.function,
      eventSourceArn: deadLetters.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
    });

    this.abandoned = this.alarmOn(logGroup, {
      id: "Abandoned",
      event: "release_abandoned",
      name: "shared-release-abandoned",
      description:
        "A release was tried as often as the release queue tries, and given up. The release table holds the step and the reason its last attempt stopped, and the release worker's log has each attempt.",
    });
    this.failed = this.alarmOn(logGroup, {
      id: "AbandonFailed",
      event: "release_failed",
      name: "shared-release-abandon-failed",
      description:
        "The dead-letter worker couldn't record a release as given up. Its message goes round the dead-letter queue until it can, for up to 14 days, and the release table says the release may still be tried.",
    });
  }

  // Counts the log's lines of one event, and alarms on any.
  private alarmOn(
    logGroup: ILogGroup,
    alarm: { id: string; event: string; name: string; description: string },
  ): Alarm {
    const filter = new MetricFilter(this, `${alarm.id}Metric`, {
      logGroup,
      filterPattern: FilterPattern.stringValue(
        "$.telemetry.event",
        "=",
        alarm.event,
      ),
      metricNamespace: RELEASE_METRIC_NAMESPACE,
      metricName: alarm.name,
      metricValue: "1",
    });
    return new Alarm(this, alarm.id, {
      alarmName: alarm.name,
      alarmDescription: `${alarm.description} See the hosting page of the platform's docs, "When a release is abandoned".`,
      metric: filter.metric({ statistic: "Sum", period: ALARM_PERIOD }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      // The filter publishes nothing for a period with no such line.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}

// The bundle is per stage, so it's built at synth, into a directory of its own for CDK to stage.
function bundleDirectory(config: DeadLetterConfig): string {
  const directory = mkdtempSync(path.join(tmpdir(), "release-dead-letters-"));
  writeFileSync(
    path.join(directory, "index.js"),
    buildDeadLetterWorker(config),
  );
  return directory;
}
