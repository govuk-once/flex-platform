import { ArnFormat, Fn, Stack } from "aws-cdk-lib";
import {
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  type ISubnet,
  type IVpc,
  SecurityGroup,
} from "aws-cdk-lib/aws-ec2";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/** Private API Gateway APIs, and the accounts a call to one may be signed in. */
export interface PrivateApiAccess {
  /** Each API by ARN, with no stage or path. It may be in an upstream's account. */
  readonly apiArns: readonly string[];
  /** The accounts of the upstream roles a call is signed as, such as an upstream's own. */
  readonly callerAccounts: readonly string[];
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
  /**
   * The DynamoDB tables the `dynamodb` endpoint may scan, by ARN, which may be in another
   * account. Each is in this region: the endpoint reaches no other.
   */
  readonly readableTables: readonly string[];
  /**
   * The secrets the `secretsmanager` endpoint may read, by ARN, or by a pattern for those Secrets
   * Manager names. An upstream may hold a gateway's secret in its own account.
   */
  readonly readableSecrets: readonly string[];
  /** The roles the `sts` endpoint may assume, by ARN, which may be in an upstream's account. */
  readonly assumableRoles: readonly string[];
  /**
   * The roles in this account that may call the `secretsmanager`, `sts` and `dynamodb` endpoints,
   * as a name pattern such as `gateway-dev-*-execution`.
   */
  readonly gatewayRoles: string;
  /** The private APIs the `execute-api` endpoint may invoke, and who may invoke them. */
  readonly invokableApis: PrivateApiAccess;
}

/**
 * The AWS APIs the isolated subnets reach, each through an endpoint. Every one but `dynamodb` has
 * private DNS, so the SDK's usual hostname resolves to it. DynamoDB's has none, so a client is
 * given the endpoint's own name, `address`. No endpoint lets anything in until a workload's
 * security group is let in with `WorkloadSecurityGroup`, and each refuses any resource it doesn't
 * name and any action but its own. One with no resource to name refuses everything.
 *
 * - `lambda`: invoking the functions named.
 * - `secretsmanager`: reading the secrets named, as a gateway's role.
 * - `sts`: assuming the roles named, as a gateway's role.
 * - `dynamodb`: scanning the tables named, as a gateway's role.
 * - `execute-api`: invoking the private APIs named, as a principal of an account named with them.
 *
 * Every endpoint but `execute-api` refuses any principal outside this account. A private API is
 * called as its upstream's own role, which a gateway assumes to sign with, so that endpoint lets
 * through the accounts those roles are in instead.
 *
 * Private DNS on `execute-api` answers for every name API Gateway gives an API in the region,
 * so nothing in the VPC reaches a public API at such a name, by NAT or any other way.
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
  /**
   * The `dynamodb` endpoint's own regional name, which a client calls it at, since it has no
   * private DNS. AWS chooses it when the endpoint is made, so it is known only at deploy.
   */
  public readonly dynamoDbAddress: string;
  /** Every endpoint, by the short name of its service, such as `secretsmanager`. */
  public readonly byService: Readonly<Record<string, InterfaceVpcEndpoint>>;
  public readonly lambda: InterfaceVpcEndpoint;
  public readonly secretsManager: InterfaceVpcEndpoint;
  public readonly sts: InterfaceVpcEndpoint;
  public readonly dynamoDb: InterfaceVpcEndpoint;
  public readonly executeApi: InterfaceVpcEndpoint;

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
      this.inAccount({
        actions: ["lambda:InvokeFunction"],
        // The pattern names an alias, so a function is reached by that alone: not without a
        // qualifier, and not by a version's number.
        resources: [functions],
      }),
    );
    this.secretsManager = this.endpoint(
      props,
      "SecretsManager",
      InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      this.inAccount({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [...props.readableSecrets],
        principals: gatewayRoles,
      }),
    );
    this.sts = this.endpoint(
      props,
      "Sts",
      InterfaceVpcEndpointAwsService.STS,
      this.inAccount({
        actions: ["sts:AssumeRole"],
        resources: [...props.assumableRoles],
        principals: gatewayRoles,
      }),
    );
    this.dynamoDb = this.endpoint(
      props,
      "DynamoDb",
      InterfaceVpcEndpointAwsService.DYNAMODB,
      this.inAccount({
        actions: ["dynamodb:Scan"],
        resources: [...props.readableTables],
        principals: gatewayRoles,
      }),
      // Its own name is allowed instead, which is known only at deploy.
      [],
      false,
    );
    // Each entry is `<hosted zone ID>:<name>`, the regional name first and then one per zone.
    this.dynamoDbAddress = Fn.select(
      1,
      Fn.split(":", Fn.select(0, this.dynamoDb.vpcEndpointDnsEntries)),
    );
    this.executeApi = this.endpoint(
      props,
      "ExecuteApi",
      InterfaceVpcEndpointAwsService.APIGATEWAY,
      this.privateApis(props.invokableApis),
      // Nothing calls API Gateway at the region's name: an API is called at its own, which is
      // its gateway's to list in config.
      [],
    );

    this.byService = this.#byService;
    this.hostnames = this.#hostnames;
  }

  // One statement for every private API, so the policy grows by an API's ARN and not by a
  // statement for each gateway: an endpoint's policy has a fixed limit on its size.
  private privateApis({
    apiArns,
    callerAccounts,
  }: PrivateApiAccess): PolicyStatement[] {
    if (apiArns.length === 0) return [];
    if (callerAccounts.length === 0) {
      throw new Error(
        "A private API is named with no account a call to it may be signed in.",
      );
    }
    return [
      new PolicyStatement({
        principals: [new AnyPrincipal()], // NOSONAR: the condition holds it to the accounts named
        actions: ["execute-api:Invoke"],
        // Any stage, method and path of the API: which of them a role may call is its upstream's
        // to say, in the role's own policy.
        resources: apiArns.map((arn) => `${arn}/*`),
        // A call is signed as an upstream's role, in the upstream's account, so the account
        // can't be held to this one. Which upstream's role a gateway signs as is held by its own
        // role, which may assume only those it names, so this names only the accounts. A call
        // with no signature has no account, so is refused.
        conditions: {
          StringEquals: { "aws:PrincipalAccount": [...callerAccounts] },
        },
      }),
    ];
  }

  // What a principal in this account may do through an endpoint, or nothing where there is no
  // resource to name.
  private inAccount({
    actions,
    resources,
    principals,
  }: {
    actions: string[];
    resources: string[];
    /** The roles that may call it, by ARN pattern, where not every one in the account may. */
    principals?: string;
  }): PolicyStatement[] {
    if (resources.length === 0) return [];
    return [
      new PolicyStatement({
        principals: [new AnyPrincipal()], // NOSONAR: the condition holds it to this account
        actions,
        resources,
        conditions: {
          StringEquals: { "aws:PrincipalAccount": Stack.of(this).account },
          ...(principals !== undefined && {
            ArnLike: { "aws:PrincipalArn": principals },
          }),
        },
      }),
    ];
  }

  private endpoint(
    { vpc, subnets }: InterfaceEndpointsProps,
    id: string,
    service: InterfaceVpcEndpointAwsService,
    /** What it lets through. With none, it refuses everything. */
    statements: readonly PolicyStatement[],
    // The SDK's regional endpoint, such as lambda.eu-west-2.amazonaws.com.
    hostnames: readonly string[] = [
      `${service.shortName}.${Stack.of(this).region}.amazonaws.com`,
    ],
    privateDnsEnabled = true,
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
      privateDnsEnabled,
      securityGroups: [securityGroup],
      open: false,
    });
    // A policy with no statement would leave the endpoint's default, which allows everything.
    if (statements.length === 0) {
      endpoint.addToPolicy(
        new PolicyStatement({
          effect: Effect.DENY,
          principals: [new AnyPrincipal()],
          actions: ["*"],
          resources: ["*"],
        }),
      );
    }
    for (const statement of statements) endpoint.addToPolicy(statement);
    this.#byService[service.shortName] = endpoint;
    this.#hostnames.push(...hostnames);
    return endpoint;
  }
}
