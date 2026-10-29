import { sortedEntries } from "@repo/utils/sorted-entries";
import type { ISecurityGroup, ISubnet, IVpc } from "aws-cdk-lib/aws-ec2";
import { StringListParameter, StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import {
  type Placement,
  securityGroupIdParameterName,
  subnetIdsParameterName,
  vpcIdParameterName,
} from "./names.ts";

export interface NetworkParametersProps {
  readonly environment: string;
  readonly vpc: IVpc;
  readonly subnets: Readonly<Record<Placement, readonly ISubnet[]>>;
  /** Each workload's group, by workload. */
  readonly securityGroups: Readonly<Record<string, ISecurityGroup>>;
}

/**
 * The IDs AWS generates that other stacks, and the release pipeline that creates domain functions,
 * need: written to SSM under names derived from config. A stack reads one with
 * `valueForStringParameter` or `valueForTypedListParameter`, which CloudFormation resolves at
 * deploy, so synth stays offline. Never `valueFromLookup`, which reads the account at synth.
 */
export class NetworkParameters extends Construct {
  constructor(scope: Construct, id: string, props: NetworkParametersProps) {
    super(scope, id);

    const { environment } = props;

    new StringParameter(this, "VpcId", {
      parameterName: vpcIdParameterName(environment),
      stringValue: props.vpc.vpcId,
    });

    for (const [placement, subnets] of sortedEntries(props.subnets)) {
      new StringListParameter(this, `${placement}SubnetIds`, {
        parameterName: subnetIdsParameterName(
          environment,
          placement as Placement,
        ),
        stringListValue: subnets.map(({ subnetId }) => subnetId),
      });
    }

    for (const [workload, securityGroup] of sortedEntries(
      props.securityGroups,
    )) {
      new StringParameter(this, `${workload}SecurityGroupId`, {
        parameterName: securityGroupIdParameterName(environment, workload),
        stringValue: securityGroup.securityGroupId,
      });
    }
  }
}
