import { sortedEntries } from "@repo/utils/sorted-entries";
import { Stack, Validations } from "aws-cdk-lib";
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  AwsCustomResource,
  type AwsSdkCall,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

import { logGroupWriteStatements } from "./function-role.ts";
import { PlatformLogGroup } from "./log-group.ts";

/**
 * Where every parameter written across regions is. CloudFormation holds the writer, not the
 * parameter, so the path is what tells one of these from a parameter nobody accounts for.
 */
export const CROSS_REGION_PARAMETER_PATH = "/flex/cross-region/";

/** `/flex/cross-region/{section}/{thing}`, for the stack that writes it and the one that reads it. */
export function crossRegionParameterName(
  section: string,
  thing: string,
): string {
  return `${CROSS_REGION_PARAMETER_PATH}${section}/${thing}`;
}

export interface CrossRegionParametersProps {
  /** The log group the function that writes them logs to. */
  readonly logGroupName: string;
  /**
   * By the region each is written in, their reader's and never this stack's own, each value by
   * its parameter's name, from `crossRegionParameterName`. A value is one AWS generates, which
   * no name derived from config could stand in for.
   */
  readonly parameters: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

// The construct ID CDK gives the one function that runs a stack's AWS custom resources.
const PROVIDER_ID = `AWS${AwsCustomResource.PROVIDER_FUNCTION_UUID.replaceAll("-", "")}`;

/**
 * Values AWS generates in this stack's region, such as a function URL's host, each written to an
 * SSM parameter in one or more other regions, where a stack reads it with
 * `valueForStringParameter` as it would one of its own region's. CloudFormation writes a
 * parameter only in a stack's own region, so a custom resource makes the call.
 *
 * A value is a property of its writer, so it is written again when it changes and never
 * otherwise, and nothing in the template changes from one synth to the next. The reader's stack
 * resolves the parameter when it deploys.
 *
 * A stack has one of these. CDK runs every AWS custom resource in a stack in one function, which
 * takes its role and its log group from the first, so a second set would run with this one's.
 */
export class CrossRegionParameters extends Construct {
  constructor(scope: Construct, id: string, props: CrossRegionParametersProps) {
    super(scope, id);

    const { logGroupName, parameters } = props;
    const stack = Stack.of(this);

    if (stack.node.tryFindChild(PROVIDER_ID) !== undefined) {
      throw new Error(
        `${this.node.path}: ${stack.stackName} already has an AWS custom resource, whose function would not run with this role or log to this log group`,
      );
    }

    const entries = sortedEntries(parameters).flatMap(([region, values]) =>
      sortedEntries(values).map(([parameterName, value]) => ({
        region,
        parameterName,
        value,
      })),
    );
    for (const { region, parameterName } of entries) {
      if (region === stack.region) {
        throw new Error(
          `${this.node.path}: ${region} is the stack's own region, where a StringParameter writes a parameter`,
        );
      }
      if (!parameterName.startsWith(CROSS_REGION_PARAMETER_PATH)) {
        throw new Error(
          `${this.node.path}: the parameter ${parameterName} must be under ${CROSS_REGION_PARAMETER_PATH}`,
        );
      }
    }

    const { logGroup, key } = new PlatformLogGroup(this, "Logs", {
      logGroupName,
    });
    const logs = logGroupWriteStatements(this, {
      logGroupName,
      logGroupKey: key,
    });

    // Never CDK's default role, which holds AWS's managed policy, and with it the permission to
    // create a log group. The policy is inline, so it is in place before the first write.
    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        Write: new PolicyDocument({
          statements: [
            ...logs.statements,
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
              resources: entries.map(({ region, parameterName }) =>
                stack.formatArn({
                  service: "ssm",
                  region,
                  resource: "parameter",
                  // The name starts with a slash, which the ARN holds once.
                  resourceName: parameterName.slice(1),
                }),
              ),
            }),
          ],
        }),
      },
    });
    Validations.of(role).acknowledge(...logs.acknowledgements);

    for (const { region, parameterName, value } of entries) {
      const write: AwsSdkCall = {
        service: "SSM",
        action: "putParameter",
        parameters: {
          Name: parameterName,
          Value: value,
          Type: "String",
          Overwrite: true,
        },
        region,
        physicalResourceId: PhysicalResourceId.of(`${region}:${parameterName}`),
      };

      // The ID is the region and the name under the path, so it stays the same whatever else is
      // written, and one name can be written in more than one region.
      const id = `${region}-${parameterName
        .slice(CROSS_REGION_PARAMETER_PATH.length)
        .replaceAll("/", "-")}`;

      new AwsCustomResource(this, id, {
        resourceType: "Custom::CrossRegionParameter",
        onCreate: write,
        onUpdate: write,
        onDelete: {
          service: "SSM",
          action: "deleteParameter",
          parameters: { Name: parameterName },
          region,
          ignoreErrorCodesMatching: "ParameterNotFound",
        },
        role,
        logGroup,
        installLatestAwsSdk: false,
      });
    }
  }
}
