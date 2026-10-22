import type { DomainNetwork } from "@repo/domains-infra";
import { cdkApp } from "@repo/infra-constructs";
import type { CloudAssembly } from "aws-cdk-lib/cx-api";

import { buildApp } from "../src/build-app.ts";
import { selectTarget } from "../src/config/select-target.ts";
import type {
  DomainAccountConfig,
  FrontdoorConfig,
  HostedDomainConfig,
  StageConfig,
  ZoneConfig,
} from "../src/config/types.ts";

export const FRONTDOOR: FrontdoorConfig = {
  account: "100000000002",
  zone: { name: "sandbox.flex-edge.example", id: "Z100000000002" },
  issuers: [
    {
      issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_example",
      clientIds: ["example-app-client"],
    },
  ],
};

export const NETWORK: DomainNetwork = {
  isolated: {
    subnetIds: ["subnet-0000000000000000a", "subnet-0000000000000000b"],
    securityGroupId: "sg-00000000000000001",
  },
  private: {
    subnetIds: ["subnet-0000000000000000c", "subnet-0000000000000000d"],
    securityGroupId: "sg-00000000000000002",
  },
};

/** Isolated, by default, in each environment's main account. */
export const DOMAIN_ONE: HostedDomainConfig = {
  domainAccount: "main",
  config: {
    name: "domain-one",
    routes: [
      { method: "GET", path: "/a" },
      { method: "PUT", path: "/a/{id}" },
    ],
  },
};

/** Public, in the second account, which has no network. Hosted in prod alone. */
export const DOMAIN_TWO: HostedDomainConfig = {
  domainAccount: "second",
  config: {
    name: "domain-two",
    access: "public",
    routes: [{ method: "GET", path: "/b" }],
  },
};

// An account's zone, named after the account as the platform team names them.
export function zone(environment: string, account: string): ZoneConfig {
  return { name: `${environment}.flex-${account}.example`, id: `Z${account}` };
}

function frontdoor(environment: string, account: string): FrontdoorConfig {
  return { ...FRONTDOOR, account, zone: zone(environment, account) };
}

export interface DomainAccountOptions {
  readonly environment: string;
  readonly network?: DomainNetwork;
}

export function domainAccount(
  name: string,
  account: string,
  { environment, network = NETWORK }: DomainAccountOptions,
): DomainAccountConfig {
  return { name, account, zone: zone(environment, account), network };
}

// The real stages' shape: two stages with one environment, one with three, and one environment
// with two domain accounts, so every loop is exercised. Environments host different domains, as
// they do while a domain is promoted, and one hosts none.
export const FIXTURE_STAGES = [
  {
    name: "platform-dev",
    shared: { account: "100000000001" },
    environments: [
      {
        name: "sandbox",
        domains: [DOMAIN_ONE],
        frontdoor: frontdoor("sandbox", "100000000002"),
        domainAccounts: [
          domainAccount("main", "100000000003", { environment: "sandbox" }),
        ],
      },
    ],
  },
  {
    name: "platform-staging",
    shared: { account: "200000000001" },
    environments: [
      {
        name: "sandbox",
        domains: [],
        frontdoor: frontdoor("sandbox", "200000000002"),
        domainAccounts: [
          domainAccount("main", "200000000003", { environment: "sandbox" }),
        ],
      },
    ],
  },
  {
    name: "platform-prod",
    shared: { account: "300000000001" },
    environments: [
      {
        name: "dev",
        domains: [DOMAIN_ONE],
        frontdoor: frontdoor("dev", "300000000002"),
        domainAccounts: [
          domainAccount("main", "300000000003", { environment: "dev" }),
        ],
      },
      {
        name: "staging",
        domains: [DOMAIN_ONE],
        frontdoor: frontdoor("staging", "300000000004"),
        domainAccounts: [
          domainAccount("main", "300000000005", { environment: "staging" }),
        ],
      },
      {
        name: "prod",
        domains: [DOMAIN_ONE, DOMAIN_TWO],
        frontdoor: frontdoor("prod", "300000000006"),
        domainAccounts: [
          domainAccount("main", "300000000007", { environment: "prod" }),
          domainAccount("second", "300000000008", {
            environment: "prod",
            network: {},
          }),
        ],
      },
    ],
  },
] as const satisfies readonly StageConfig[];

const assemblies = new Map<StageConfig, CloudAssembly>();

/** The whole of a stage, synthesized once and shared by every test that reads it. */
export function synthesizedStage(stage: StageConfig): CloudAssembly {
  let assembly = assemblies.get(stage);
  if (assembly === undefined) {
    const app = cdkApp();
    buildApp(app, stage, selectTarget(stage, undefined));
    assembly = app.synth();
    assemblies.set(stage, assembly);
  }
  return assembly;
}
