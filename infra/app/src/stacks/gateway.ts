import {
  CALLER_TOKEN_KEYS_OBJECT,
  callerTokenKeysBucketName,
} from "@repo/frontdoor-infra";
import { callerTokenAudience } from "@repo/frontdoor-shared";
import { gatewayFunctionName } from "@repo/gateway-core";
import {
  GatewayFunction,
  gatewayFunctionPattern,
  gatewayLogGroupName,
  gatewayRoleName,
  GatewaySecret,
  gatewaySecretName,
  gatewaySecretPattern,
  upstreamAccess,
} from "@repo/gateway-infra";
import {
  endpointIdParameterName,
  NETWORK_REGION,
  securityGroupIdParameterName,
  subnetIdsParameterName,
} from "@repo/infra-constructs";
import { Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
  GatewayConfig,
} from "../config/types.ts";

// Each domain account in an environment runs its own copy of a gateway its domains call, so the
// account is in the name, as in the network's.
export function gatewayStackName(
  environment: EnvironmentConfig,
  domainAccount: DomainAccountConfig,
  gateway: GatewayConfig,
): string {
  return `gateway-${environment.name}-${domainAccount.name}-${gateway.id}`;
}

/**
 * The secret a gateway reads, by ARN: an upstream's as config gives it, or a pattern for the one
 * its stack creates, whose ARN ends in six characters Secrets Manager chooses. The gateway's role
 * names it so.
 */
export function gatewaySecretArn(
  environment: EnvironmentConfig,
  domainAccount: DomainAccountConfig,
  gateway: GatewayConfig,
): string {
  if (gateway.secret !== "create") return gateway.secret.arn;
  const name = gatewaySecretName(environment.name, gateway.id);
  return `arn:aws:secretsmanager:${NETWORK_REGION}:${domainAccount.account}:secret:${name}-??????`;
}

/**
 * The secret a gateway reads, as the network's endpoint names it: an upstream's by its ARN, or
 * every secret a gateway's stack creates in the domain account, by one pattern, so the endpoint's
 * policy doesn't grow with each gateway that has its own.
 */
export function endpointSecretArn(
  environment: EnvironmentConfig,
  domainAccount: DomainAccountConfig,
  gateway: GatewayConfig,
): string {
  if (gateway.secret !== "create") return gateway.secret.arn;
  const pattern = gatewaySecretPattern(environment.name);
  return `arn:aws:secretsmanager:${NETWORK_REGION}:${domainAccount.account}:secret:${pattern}`;
}

interface GatewayStackProps {
  readonly environment: EnvironmentConfig;
  readonly domainAccount: DomainAccountConfig;
  readonly gateway: GatewayConfig;
  /** The bundle codegen wrote for the gateway. */
  readonly bundle: string;
}

/**
 * One gateway's function, its role, its log group, and its secret if it has its own, in the domain
 * account whose network it runs in. A stack per gateway, so adding or removing one changes no
 * other.
 */
export class GatewayStack extends Stack {
  constructor(
    scope: Construct,
    { environment, domainAccount, gateway, bundle }: GatewayStackProps,
  ) {
    super(scope, gatewayStackName(environment, domainAccount, gateway), {
      description: `Flex gateway ${gateway.id} in the ${environment.name} environment`,
      env: { account: domainAccount.account, region: NETWORK_REGION },
      // Deleting it would stop every domain's calls to the gateway's upstream.
      terminationProtection: true,
    });

    const roleName = gatewayRoleName(environment.name, gateway.id);

    const endpointId = (service: string) =>
      StringParameter.valueForStringParameter(
        this,
        endpointIdParameterName(environment.name, service),
      );
    const secretsEndpointId = endpointId("secretsmanager");

    const secretArn =
      gateway.secret === "create"
        ? new GatewaySecret(this, "Secret", {
            secretName: gatewaySecretName(environment.name, gateway.id),
            readerArn: this.formatArn({
              service: "iam",
              region: "",
              resource: "role",
              resourceName: roleName,
            }),
            endpointId: secretsEndpointId,
          }).secret.secretArn
        : gateway.secret.arn;

    const keysBucket = callerTokenKeysBucketName(
      environment.name,
      environment.frontdoor.account,
    );

    new GatewayFunction(this, "Gateway", {
      functionName: gatewayFunctionName(environment.name, gateway.id),
      roleName,
      logGroupName: gatewayLogGroupName(environment.name, gateway.id),
      bundle,
      environment: {
        FLEX_UPSTREAM_SECRET_ARN: secretArn,
        ...(gateway.target !== null && {
          FLEX_UPSTREAM_TARGET: gateway.target,
        }),
        FLEX_CALLER_TOKEN_KEYS_BUCKET: keysBucket,
        FLEX_CALLER_TOKEN_KEYS_OBJECT: CALLER_TOKEN_KEYS_OBJECT,
        FLEX_CALLER_TOKEN_KEYS_ACCOUNT: environment.frontdoor.account,
        FLEX_CALLER_TOKEN_AUDIENCE: callerTokenAudience(environment.name),
      },
      statements: [
        ...upstreamAccess({
          secretArn: gatewaySecretArn(environment, domainAccount, gateway),
          secretKeyArn:
            gateway.secret === "create" ? null : gateway.secret.keyArn,
          roleArns: gateway.roleArns,
          endpointIds: [secretsEndpointId, endpointId("sts")],
        }),
        // The edge's public keys, in the frontdoor account's bucket, whose policy lets this
        // role read them too. Bucket names are global, so it is held to that account's.
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["s3:GetObject"],
          resources: [
            `arn:${this.partition}:s3:::${keysBucket}/${CALLER_TOKEN_KEYS_OBJECT}`,
          ],
          conditions: {
            StringEquals: {
              "aws:ResourceAccount": environment.frontdoor.account,
            },
          },
        }),
      ],
      subnetIdsParameterName: subnetIdsParameterName(
        environment.name,
        gateway.placement,
      ),
      securityGroupIdParameterName: securityGroupIdParameterName(
        environment.name,
        `${gateway.placement}-gateway`,
      ),
      gatewayFunctions: gatewayFunctionPattern(environment.name),
    });
  }
}
