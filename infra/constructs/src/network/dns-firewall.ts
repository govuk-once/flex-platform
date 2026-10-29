import {
  ArnFormat,
  CfnResource,
  Duration,
  Stack,
  Validations,
} from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import type { IVpc } from "aws-cdk-lib/aws-ec2";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { ResourcePolicy } from "aws-cdk-lib/aws-logs";
import {
  CfnFirewallDomainList,
  CfnFirewallRuleGroup,
  CfnFirewallRuleGroupAssociation,
  CfnResolverQueryLoggingConfig,
  CfnResolverQueryLoggingConfigAssociation,
} from "aws-cdk-lib/aws-route53resolver";
import { Construct } from "constructs";

import { PlatformLogGroup } from "../log-group.ts";
import { dnsAllowlist } from "./dns-names.ts";
import { dnsFirewallName, dnsQueryLogGroupName } from "./names.ts";

// Lower is evaluated first, between 101 and 9900. The allowlist's group comes first, the block's
// last, with room between for any group added later.
const ALLOW_PRIORITY = 1000;
const BLOCK_PRIORITY = 9000;

export interface DnsFirewallProps {
  readonly environment: string;
  readonly vpc: IVpc;
  /** Exact names the VPC's workloads may resolve: AWS's, and every name a gateway connects to. */
  readonly hostnames: readonly string[];
}

/**
 * Default-deny DNS for the VPC, with Route 53 Resolver DNS Firewall. A name a workload asks for
 * resolves only if it is on the allowlist; anything else is answered `NXDOMAIN`. The allowlist is VPC-wide: it doesn't
 * give one workload names another lacks.
 *
 * - Two rule groups. The block is a group of its own, `*` with no exceptions, which no allowlist
 *   change touches, so an ordinary update or rollback of the allowlist never removes it. The allowlist
 *   is a domain list the allow group's one rule names, so a change to it changes only that list.
 * - Fail closed, set explicitly: if DNS Firewall can't answer, the resolver answers `SERVFAIL`.
 *   AWS applies it only while a rule group is associated with the VPC.
 * - Resolver query logging, with the firewall's decision and the address a query came from, to a
 *   `PlatformLogGroup`. Resolver doesn't log a query it answers from its cache, so the log shows
 *   names asked for, not how often. A query name can carry data a workload is trying to send out,
 *   so the log is as sensitive as anything the platform holds.
 * - An alarm when anything is blocked. Nothing a workload is allowed to need is ever blocked, so any
 *   block is unexpected.
 */
export class DnsFirewall extends Construct {
  /** Goes off on any blocked query. It has no action until the platform has alerting. */
  public readonly blockedQueries: Alarm;

  constructor(scope: Construct, id: string, props: DnsFirewallProps) {
    super(scope, id);

    const { environment, vpc } = props;
    const name = (thing: string) => dnsFirewallName(environment, thing);

    const allowed = new CfnFirewallDomainList(this, "AllowedNames", {
      name: name("allowed"),
      domains: dnsAllowlist(props.hostnames),
    });
    const everything = new CfnFirewallDomainList(this, "EveryName", {
      name: name("every-name"),
      domains: ["*"],
    });

    const allowGroup = new CfnFirewallRuleGroup(this, "Allow", {
      name: name("allow"),
      firewallRules: [
        {
          priority: 100,
          firewallDomainListId: allowed.attrId,
          action: "ALLOW",
          // An allowed name's CNAME or DNAME chain is the upstream's to change, such as moving
          // CDN, so config lists only the names a gateway connects to.
          firewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN",
        },
      ],
    });
    // No `qtype`, so every query type is blocked.
    const blockGroup = new CfnFirewallRuleGroup(this, "Block", {
      name: name("block"),
      firewallRules: [
        {
          priority: 100,
          firewallDomainListId: everything.attrId,
          action: "BLOCK",
          blockResponse: "NXDOMAIN",
          firewallDomainRedirectionAction: "INSPECT_REDIRECTION_DOMAIN",
        },
      ],
    });

    new CfnFirewallRuleGroupAssociation(this, "AllowAssociation", {
      name: name("allow"),
      firewallRuleGroupId: allowGroup.attrId,
      vpcId: vpc.vpcId,
      priority: ALLOW_PRIORITY,
    });
    new CfnFirewallRuleGroupAssociation(this, "BlockAssociation", {
      name: name("block"),
      firewallRuleGroupId: blockGroup.attrId,
      vpcId: vpc.vpcId,
      priority: BLOCK_PRIORITY,
    });

    // Fail closed is AWS's default, but a default is nothing a test or a reviewer can see. The
    // resource is newer than aws-cdk-lib's typed classes and its CloudFormation validation schema.
    const failClosed = new CfnResource(this, "FailClosed", {
      type: "AWS::Route53Resolver::FirewallConfig",
      properties: { ResourceId: vpc.vpcId, FirewallFailOpen: "DISABLED" },
    });
    Validations.of(failClosed).acknowledge({
      id: "CloudFormation-Validate::F3006",
      reason:
        "AWS::Route53Resolver::FirewallConfig is in the CloudFormation template reference, but not yet in the schema aws-cdk-lib validates against.",
    });
    this.logQueries(environment, vpc);

    this.blockedQueries = new Alarm(this, "BlockedQueries", {
      alarmName: name("blocked-queries"),
      alarmDescription: `A workload in the ${environment} network asked for a name the DNS allowlist doesn't hold. See the network page of the platform's docs, "Investigating a blocked query".`,
      metric: new Metric({
        namespace: "AWS/Route53Resolver",
        metricName: "FirewallRuleQueryVolume",
        dimensionsMap: {
          FirewallRuleGroupId: blockGroup.attrId,
          FirewallDomainListId: everything.attrId,
        },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      // DNS Firewall publishes nothing for a period with no blocks.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  private logQueries(environment: string, vpc: IVpc): void {
    const stack = Stack.of(this);
    const { logGroup } = new PlatformLogGroup(this, "QueryLogs", {
      logGroupName: dnsQueryLogGroupName(environment),
    });

    // Written here rather than left for Resolver to add to the account's policies when it first
    // delivers, so the grant is ours, reviewed and held to this account's deliveries.
    const delivery = new ResourcePolicy(this, "QueryLogDelivery", {
      resourcePolicyName: dnsFirewallName(environment, "query-logs"),
      policyStatements: [
        new PolicyStatement({
          sid: "AllowQueryLogDelivery",
          principals: [new ServicePrincipal("delivery.logs.amazonaws.com")],
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          // The log group's ARN already ends `:*`, which covers its streams.
          resources: [logGroup.logGroupArn],
          conditions: {
            StringEquals: { "aws:SourceAccount": stack.account },
            ArnLike: {
              "aws:SourceArn": stack.formatArn({
                service: "logs",
                resource: "*",
                arnFormat: ArnFormat.NO_RESOURCE_NAME,
              }),
            },
          },
        }),
      ],
    });

    const config = new CfnResolverQueryLoggingConfig(this, "QueryLogging", {
      name: dnsFirewallName(environment, "query-logs"),
      destinationArn: logGroup.logGroupArn,
    });
    config.node.addDependency(delivery);
    new CfnResolverQueryLoggingConfigAssociation(
      this,
      "QueryLoggingAssociation",
      {
        resolverQueryLogConfigId: config.attrId,
        resourceId: vpc.vpcId,
      },
    );
  }
}
