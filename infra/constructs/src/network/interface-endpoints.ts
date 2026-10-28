import { ArnFormat, Stack } from "aws-cdk-lib";
import {
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  type ISubnet,
  type IVpc,
  SecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import { AnyPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface InterfaceEndpointsProps {
  readonly vpc: IVpc;
  /** The isolated subnets: the endpoints are how they reach AWS. */
  readonly subnets: readonly ISubnet[];
  /** The functions the `lambda` endpoint may invoke, as a name pattern such as `gateway-dev-*`. */
  readonly invokableFunctions: string;
}

/**
 * The AWS APIs the isolated subnets reach, each through an endpoint with private DNS, so the
 * SDK's usual hostname resolves to it. No endpoint lets anything in until a workload's security
 * group is let in with `WorkloadSecurityGroup`, and each refuses any principal or resource outside
 * this account, and any action but the ones named here.
 *
 * - `lambda`: invoking the functions named, and nothing else.
 * - `secretsmanager`: reading a secret.
 * - `sts`: assuming a role.
 *
 * An endpoint costs the same whether it's used or not, so one is added when something calls its
 * API. Traces need none: Lambda's X-Ray daemon sends from outside the VPC.
 */
export class InterfaceEndpoints extends Construct {
  public readonly lambda: InterfaceVpcEndpoint;
  public readonly secretsManager: InterfaceVpcEndpoint;
  public readonly sts: InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props: InterfaceEndpointsProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const functions = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: props.invokableFunctions,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    this.lambda = this.endpoint(
      props,
      "Lambda",
      InterfaceVpcEndpointAwsService.LAMBDA,
      {
        actions: ["lambda:InvokeFunction"],
        // The pattern ends in `*`, so it covers a qualifier, such as `:live`, too.
        resources: [functions],
      },
    );
    this.secretsManager = this.endpoint(
      props,
      "SecretsManager",
      InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      { actions: ["secretsmanager:GetSecretValue"], resources: ["*"] },
    );
    this.sts = this.endpoint(props, "Sts", InterfaceVpcEndpointAwsService.STS, {
      actions: ["sts:AssumeRole"],
      resources: ["*"],
    });
  }

  private endpoint(
    { vpc, subnets }: InterfaceEndpointsProps,
    id: string,
    service: InterfaceVpcEndpointAwsService,
    { actions, resources }: { actions: string[]; resources: string[] },
  ): InterfaceVpcEndpoint {
    // An endpoint only answers, so its group lets nothing out, and nothing in until a workload's
    // group is let in. CDK's own would let the whole VPC in, and allow everything out.
    const securityGroup = new SecurityGroup(this, `${id}SecurityGroup`, {
      vpc,
      description: `The ${service.shortName} interface endpoint`,
      allowAllOutbound: false,
    });
    const endpoint = new InterfaceVpcEndpoint(this, id, {
      vpc,
      service,
      subnets: { subnets: [...subnets] },
      privateDnsEnabled: true,
      securityGroups: [securityGroup],
      open: false,
    });
    endpoint.addToPolicy(
      new PolicyStatement({
        principals: [new AnyPrincipal()],
        actions,
        resources,
        // An upstream may keep a gateway's secret, or the role it signs as, in its own account, so
        // gateways' deployment is likely to widen the resource's account.
        conditions: {
          StringEquals: {
            "aws:PrincipalAccount": Stack.of(this).account,
            "aws:ResourceAccount": Stack.of(this).account,
          },
        },
      }),
    );
    return endpoint;
  }
}
