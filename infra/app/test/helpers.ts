import { cdkApp } from "@repo/infra-constructs";
import type { CloudAssembly } from "aws-cdk-lib/cx-api";

import { buildApp } from "../src/build-app.ts";
import { selectTarget } from "../src/config/select-target.ts";
import type {
  DomainAccountConfig,
  FrontdoorConfig,
  GatewayConfig,
  NetworkConfig,
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

// An account's zone, named after the account as the platform team names them.
export function zone(environment: string, account: string): ZoneConfig {
  return { name: `${environment}.flex-${account}.example`, id: `Z${account}` };
}

// Two zones in the stages only the platform team uses, three in the rest, as committed.
export const TWO_ZONES: NetworkConfig = {
  availabilityZones: ["eu-west-2a", "eu-west-2b"],
};

const THREE_ZONES: NetworkConfig = {
  availabilityZones: ["eu-west-2a", "eu-west-2b", "eu-west-2c"],
};

// A gateway with an upstream, a token host and a CDN behind both, the same in every environment so
// environments stay alike.
export const GATEWAYS: readonly GatewayConfig[] = [
  {
    id: "udp",
    hostnames: ["api.udp.example", "auth.udp.example"],
  },
];

function frontdoor(environment: string, account: string): FrontdoorConfig {
  return { ...FRONTDOOR, account, zone: zone(environment, account) };
}

export function domainAccount(
  environment: string,
  name: string,
  account: string,
  domains: readonly string[] = [],
  network: NetworkConfig = TWO_ZONES,
): DomainAccountConfig {
  return {
    name,
    account,
    domains,
    zone: zone(environment, account),
    network,
    gateways: GATEWAYS,
  };
}

// The same in every environment, so environments stay alike.
const FIXTURE_DOMAINS = ["domain-a", "domain-b"];

// The real stages' shape: two stages with one environment, one with three, and one environment
// with two domain accounts, the second hosting no domains, so every loop is exercised.
export const FIXTURE_STAGES = [
  {
    name: "platform-dev",
    shared: { account: "100000000001" },
    environments: [
      {
        name: "sandbox",
        domainAccounts: [
          domainAccount("sandbox", "main", "100000000003", FIXTURE_DOMAINS),
        ],
        frontdoor: frontdoor("sandbox", "100000000002"),
      },
    ],
  },
  {
    name: "platform-staging",
    shared: { account: "200000000001" },
    environments: [
      {
        name: "sandbox",
        domainAccounts: [
          domainAccount("sandbox", "main", "200000000003", FIXTURE_DOMAINS),
        ],
        frontdoor: frontdoor("sandbox", "200000000002"),
      },
    ],
  },
  {
    name: "platform-prod",
    shared: { account: "300000000001" },
    environments: [
      {
        name: "dev",
        domainAccounts: [
          domainAccount(
            "dev",
            "main",
            "300000000003",
            FIXTURE_DOMAINS,
            THREE_ZONES,
          ),
        ],
        frontdoor: frontdoor("dev", "300000000002"),
      },
      {
        name: "staging",
        domainAccounts: [
          domainAccount(
            "staging",
            "main",
            "300000000005",
            FIXTURE_DOMAINS,
            THREE_ZONES,
          ),
        ],
        frontdoor: frontdoor("staging", "300000000004"),
      },
      {
        name: "prod",
        domainAccounts: [
          domainAccount(
            "prod",
            "main",
            "300000000007",
            FIXTURE_DOMAINS,
            THREE_ZONES,
          ),
          domainAccount("prod", "second", "300000000008", [], THREE_ZONES),
        ],
        frontdoor: frontdoor("prod", "300000000006"),
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
