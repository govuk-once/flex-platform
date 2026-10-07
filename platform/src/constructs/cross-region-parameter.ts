import { Stack } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { ILogGroup } from "aws-cdk-lib/aws-logs";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

export interface CrossRegionParameterProps {
  readonly parameterName: string;
  readonly region: string;
  readonly logGroup?: ILogGroup;
}

export class CrossRegionParameter extends AwsCustomResource {
  public readonly stringValue: string;

  constructor(scope: Construct, id: string, props: CrossRegionParameterProps) {
    const stack = Stack.of(scope);
    const read = {
      service: "SSM",
      action: "getParameter",
      parameters: { Name: props.parameterName },
      region: props.region,
      // A new id on every synth, so the read runs on every deploy.
      physicalResourceId: PhysicalResourceId.of(
        `${props.region}:${props.parameterName}:${String(Date.now())}`,
      ),
    };

    super(scope, id, {
      onCreate: read,
      onUpdate: read,
      ...(props.logGroup && { logGroup: props.logGroup }),
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${stack.partition}:ssm:${props.region}:${stack.account}:parameter${props.parameterName}`,
          ],
        }),
      ]),
    });

    this.stringValue = this.getResponseField("Parameter.Value");
  }
}
