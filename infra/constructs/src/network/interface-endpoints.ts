import { ArnFormat, Stack } from "aws-cdk-lib";
import {
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  type ISubnet,
  type IVpc,
  SecurityGroup,
  VpcEndpointPrivateDnsOnlyForInboundResolverEndpoint,
} from "aws-cdk-lib/aws-ec2";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/** An S3 object, by its bucket's name, its key, and the account that owns the bucket. */
export interface S3Object {
  readonly bucket: string;
  readonly key: string;
  readonly account: string;
}

export interface InterfaceEndpointsProps {
  readonly vpc: IVpc;
  /** The isolated subnets: the endpoints are how they reach AWS. */
  readonly subnets: readonly ISubnet[];
  /**
   * The functions the `lambda` endpoint may invoke, as a name pattern, with the alias each is
   * invoked by, such as `gateway-dev-*:live`.
   */
  readonly invokableFunctions: string;
  /** The objects the `s3` endpoint may read, which may be in another account's bucket. */
  readonly readableObjects: readonly S3Object[];
  /**
   * The secrets the `secretsmanager` endpoint may read, by ARN, or by a pattern for those Secrets
   * Manager names. An upstream may hold a gateway's secret in its own account.
   */
  readonly readableSecrets: readonly string[];
  /** The roles the `sts` endpoint may assume, by ARN, which may be in an upstream's account. */
  readonly assumableRoles: readonly string[];
  /**
   * The roles in this account that may call the `secretsmanager` and `sts` endpoints, as a name
   * pattern such as `gateway-dev-*-execution`.
   */
  readonly gatewayRoles: string;
}

/**
 * The AWS APIs the isolated subnets reach, each through an endpoint with private DNS, so the
 * SDK's usual hostname resolves to it. No endpoint lets anything in until a workload's security
 * group is let in with `WorkloadSecurityGroup`, and each refuses any principal outside this account,
 * any resource it doesn't name, and any action but its own. One with no resource to name refuses
 * everything.
 *
 * - `lambda`: invoking the functions named.
 * - `secretsmanager`: reading the secrets named, as a gateway's role.
 * - `sts`: assuming the roles named, as a gateway's role.
 * - `s3`: reading the objects named.
 *
 * An endpoint costs the same whether it's used or not, so one is added when something calls its
 * API. Traces need none: Lambda's X-Ray daemon sends from outside the VPC.
 */
export class InterfaceEndpoints extends Construct {
  /**
   * The names the SDK calls the endpoints' APIs at, which private DNS answers with the endpoints'
   * addresses. The DNS allowlist starts from these.
   */
  public readonly hostnames: readonly string[];
  /** Every endpoint, by the short name of its service, such as `secretsmanager`. */
  public readonly byService: Readonly<Record<string, InterfaceVpcEndpoint>>;
  public readonly lambda: InterfaceVpcEndpoint;
  public readonly secretsManager: InterfaceVpcEndpoint;
  public readonly sts: InterfaceVpcEndpoint;
  public readonly s3: InterfaceVpcEndpoint;

  readonly #byService: Record<string, InterfaceVpcEndpoint> = {};
  readonly #hostnames: string[] = [];

  constructor(scope: Construct, id: string, props: InterfaceEndpointsProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const gatewayRoles = stack.formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: props.gatewayRoles,
    });
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
        // The pattern names an alias, so a function is reached by that alone: not without a
        // qualifier, and not by a version's number.
        resources: [functions],
      },
    );
    this.secretsManager = this.endpoint(
      props,
      "SecretsManager",
      InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      {
        actions: ["secretsmanager:GetSecretValue"],
        resources: [...props.readableSecrets],
        principals: gatewayRoles,
      },
    );
    this.sts = this.endpoint(props, "Sts", InterfaceVpcEndpointAwsService.STS, {
      actions: ["sts:AssumeRole"],
      resources: [...props.assumableRoles],
      principals: gatewayRoles,
    });
    this.s3 = this.endpoint(props, "S3", InterfaceVpcEndpointAwsService.S3, {
      actions: ["s3:GetObject"],
      resources: props.readableObjects.map(
        ({ bucket, key }) => `arn:${stack.partition}:s3:::${bucket}/${key}`,
      ),
      // The SDK calls S3 at the bucket's own name, which private DNS answers too.
      hostnames: props.readableObjects.map(
        ({ bucket }) => `${bucket}.s3.${stack.region}.amazonaws.com`,
      ),
      // Bucket names are global, so a bucket of the same name in another account is refused.
      resourceAccounts: [
        ...new Set(props.readableObjects.map(({ account }) => account)),
      ],
    });

    this.byService = this.#byService;
    this.hostnames = this.#hostnames;
  }

  private endpoint(
    { vpc, subnets }: InterfaceEndpointsProps,
    id: string,
    service: InterfaceVpcEndpointAwsService,
    {
      actions,
      resources,
      // The SDK's regional endpoint, such as lambda.eu-west-2.amazonaws.com.
      hostnames = [
        `${service.shortName}.${Stack.of(this).region}.amazonaws.com`,
      ],
      resourceAccounts,
      principals,
    }: {
      actions: string[];
      resources: string[];
      hostnames?: string[];
      /** The accounts the resources must be in, where their names don't say. */
      resourceAccounts?: string[];
      /** The roles that may call it, by ARN pattern, where not every one in the account may. */
      principals?: string;
    },
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
      // S3 alone offers both kinds of endpoint, and would otherwise answer the VPC's own lookups
      // only through a gateway endpoint, which the network has none of.
      ...(service.shortName === "s3" && {
        privateDnsOnlyForInboundResolverEndpoint:
          VpcEndpointPrivateDnsOnlyForInboundResolverEndpoint.ALL_RESOLVERS,
      }),
      securityGroups: [securityGroup],
      open: false,
    });
    // A policy with no statement would leave the endpoint's default, which allows everything.
    endpoint.addToPolicy(
      resources.length === 0
        ? new PolicyStatement({
            effect: Effect.DENY,
            principals: [new AnyPrincipal()],
            actions: ["*"],
            resources: ["*"],
          })
        : new PolicyStatement({
            principals: [new AnyPrincipal()], // NOSONAR: the condition holds it to this account
            actions,
            resources,
            conditions: {
              StringEquals: {
                "aws:PrincipalAccount": Stack.of(this).account,
                ...(resourceAccounts !== undefined && {
                  "aws:ResourceAccount": resourceAccounts,
                }),
              },
              ...(principals !== undefined && {
                ArnLike: { "aws:PrincipalArn": principals },
              }),
            },
          }),
    );
    this.#byService[service.shortName] = endpoint;
    this.#hostnames.push(...hostnames);
    return endpoint;
  }
}
