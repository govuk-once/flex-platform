import { cdkApp } from "@repo/infra-constructs";
import type { CloudAssembly } from "aws-cdk-lib/cx-api";

import { buildApp } from "../src/build-app.ts";
import { selectTarget } from "../src/config/select-target.ts";
import type {
  DomainAccountConfig,
  DomainConfig,
  FrontdoorConfig,
  GatewayConfig,
  NetworkConfig,
  SharedConfig,
  StageConfig,
  StageDomainConfig,
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
  testUsers: false,
};

// A stage's test user pool, which one fixture environment trusts.
export const TEST_USERS = {
  issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_testusers",
  clientIds: ["test-users-client"],
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

// A gateway with an upstream, a token host and a CDN behind both, whose upstream holds its secret
// and the role it signs as.
export const UDP = {
  id: "udp",
  hostnames: ["api.udp.example", "auth.udp.example"],
  placement: "private",
  secret: {
    arn: "arn:aws:secretsmanager:eu-west-2:200000000001:secret:udp/flex/consumer-AbCdEf",
    keyArn:
      "arn:aws:kms:eu-west-2:200000000001:key/00000000-0000-4000-8000-000000000000",
  },
  target: null,
  roleArns: ["arn:aws:iam::200000000001:role/udp-flex-consumer"],
} as const satisfies GatewayConfig;

// The same gateway with a secret its stack creates, so it assumes no upstream role, and its target
// in config, since its secret holds only what a person puts. Only `udp` has a package with a
// bundle, so this varies it rather than naming another gateway, and the stages don't deploy it.
export const OWN_SECRET_GATEWAY = {
  ...UDP,
  secret: "create",
  roleArns: [],
  target: "https://api.udp.example",
} as const satisfies GatewayConfig;

function frontdoor(
  environment: string,
  account: string,
  testUsers = false,
): FrontdoorConfig {
  return { ...FRONTDOOR, account, zone: zone(environment, account), testUsers };
}

export function domainAccount(
  environment: string,
  name: string,
  account: string,
  domains: readonly DomainConfig[] = [],
  network: NetworkConfig = TWO_ZONES,
): DomainAccountConfig {
  return {
    name,
    account,
    domains,
    zone: zone(environment, account),
    network,
    gateways: [UDP],
  };
}

const FIXTURE_DOMAINS = ["domain-a", "domain-b"];

// One domain with a repository that may release it, and one whose repository doesn't exist yet.
export const REPOSITORY = {
  name: "example-org/domain-a",
  id: "700000001",
  ownerId: "800000001",
};

export const FIXTURE_STAGE_DOMAINS: readonly StageDomainConfig[] = [
  { name: "domain-a", repository: REPOSITORY },
  { name: "domain-b", repository: null },
];

// A stage's shared account, with its zone named after the account as the others are, and no test
// user pool.
export function shared(account: string): SharedConfig & { testUsers: null } {
  return { account, zone: zone("shared", account), testUsers: null };
}

// The real stages' shape: two stages with one environment, one with three, and one environment
// with two domain accounts, the second hosting no domains, so every loop is exercised. platform-prod
// has a test user pool, which its dev environment trusts, and its environments promote one to the
// next, as the committed platform-prod's do.
export const FIXTURE_STAGES = [
  {
    name: "platform-dev",
    shared: shared("100000000001"),
    domains: FIXTURE_STAGE_DOMAINS,
    environments: [
      {
        name: "sandbox",
        release: "publish",
        domainAccounts: [
          domainAccount("sandbox", "main", "100000000003", FIXTURE_DOMAINS),
        ],
        frontdoor: frontdoor("sandbox", "100000000002"),
      },
    ],
  },
  {
    name: "platform-staging",
    shared: shared("200000000001"),
    domains: FIXTURE_STAGE_DOMAINS,
    environments: [
      {
        name: "sandbox",
        release: "publish",
        domainAccounts: [
          domainAccount("sandbox", "main", "200000000003", FIXTURE_DOMAINS),
        ],
        frontdoor: frontdoor("sandbox", "200000000002"),
      },
    ],
  },
  {
    name: "platform-prod",
    shared: { ...shared("300000000001"), testUsers: TEST_USERS },
    domains: FIXTURE_STAGE_DOMAINS,
    environments: [
      {
        name: "dev",
        release: "publish",
        domainAccounts: [
          domainAccount(
            "dev",
            "main",
            "300000000003",
            FIXTURE_DOMAINS,
            THREE_ZONES,
          ),
        ],
        frontdoor: frontdoor("dev", "300000000002", true),
      },
      {
        name: "staging",
        release: { promoteFrom: "dev" },
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
        release: { promoteFrom: "staging" },
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
