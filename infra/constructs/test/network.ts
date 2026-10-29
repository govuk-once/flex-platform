import { type App, Stack, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";

import { cdkApp } from "../src/cdk-app.ts";
import { DnsFirewall } from "../src/network/dns-firewall.ts";
import { FlowLogs } from "../src/network/flow-logs.ts";
import { InterfaceEndpoints } from "../src/network/interface-endpoints.ts";
import { networkZones } from "../src/network/layout.ts";
import { NatAddresses } from "../src/network/nat-addresses.ts";
import { NetworkAcls } from "../src/network/network-acls.ts";
import { NetworkParameters } from "../src/network/network-parameters.ts";
import { NetworkVpc } from "../src/network/vpc.ts";
import { WorkloadSecurityGroup } from "../src/network/workload-security-group.ts";
import { BucketHttpsCheck } from "../src/validation/bucket-https-check.ts";
import { LogGroupCheck } from "../src/validation/log-group-check.ts";

export const ACCOUNT = "123456789012";

/** A stack that names its zones, as the network's stack must. */
export class ZonedStack extends Stack {
  readonly #zones: readonly string[];

  constructor(app: App, zones: readonly string[]) {
    super(app, "Test", { env: { account: ACCOUNT, region: "eu-west-2" } });
    this.#zones = zones;
  }

  override get availabilityZones(): string[] {
    return [...this.#zones];
  }
}

/** The names a gateway in the network resolves. */
export interface UpstreamNames {
  readonly hostnames: readonly string[];
}

export const UPSTREAM: UpstreamNames = {
  hostnames: ["api.upstream.example", "auth.upstream.example"],
};

export interface BuiltNetwork {
  readonly app: App;
  readonly stack: Stack;
  readonly template: Template;
}

/** Every network construct, wired as the app's network stack wires them. */
export function buildNetwork(
  zones: readonly string[] = ["eu-west-2a", "eu-west-2b"],
  nag = false,
  upstream: UpstreamNames = UPSTREAM,
): BuiltNetwork {
  const app = cdkApp();
  if (nag) {
    Validations.of(app).addPlugins(
      new AwsSolutionsChecks(app),
      new LogGroupCheck(),
      new BucketHttpsCheck(),
    );
  }
  const sorted = networkZones(zones);
  const stack = new ZonedStack(app, sorted);
  const natAddresses = new NatAddresses(stack, "NatAddresses", {
    environment: "sandbox",
    zones: sorted,
  });
  const { vpc, subnets } = new NetworkVpc(stack, "Network", {
    environment: "sandbox",
    zones: sorted,
    natAddresses,
  });
  new NetworkAcls(stack, "NetworkAcls", { vpc, subnets });
  new FlowLogs(stack, "FlowLogs", { environment: "sandbox", vpc });
  const endpoints = new InterfaceEndpoints(stack, "Endpoints", {
    vpc,
    subnets: subnets.isolated,
    invokableFunctions: "gateway-sandbox-*",
  });
  new DnsFirewall(stack, "DnsFirewall", {
    environment: "sandbox",
    vpc,
    hostnames: [...endpoints.hostnames, ...upstream.hostnames],
  });
  const domain = new WorkloadSecurityGroup(stack, "Domain", {
    vpc,
    workload: "domain",
    placement: "isolated",
    endpoints: [endpoints.lambda],
  });
  const gateway = new WorkloadSecurityGroup(stack, "PrivateGateway", {
    vpc,
    workload: "private-gateway",
    placement: "private",
    endpoints: [endpoints.secretsManager, endpoints.sts],
  });
  new NetworkParameters(stack, "Parameters", {
    environment: "sandbox",
    vpc,
    subnets: { isolated: subnets.isolated, private: subnets.private },
    securityGroups: {
      domain: domain.securityGroup,
      "private-gateway": gateway.securityGroup,
    },
  });

  return { app, stack, template: Template.fromStack(stack) };
}
