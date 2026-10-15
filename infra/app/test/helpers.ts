import { cdkApp } from "@repo/infra-constructs";
import type { CloudAssembly } from "aws-cdk-lib/cx-api";

import { buildApp } from "../src/build-app.ts";
import { selectTarget } from "../src/config/select-target.ts";
import type {
  FrontdoorConfig,
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
function zone(environment: string, account: string): ZoneConfig {
  return { name: `${environment}.flex-${account}.example`, id: `Z${account}` };
}

function frontdoor(environment: string, account: string): FrontdoorConfig {
  return { ...FRONTDOOR, account, zone: zone(environment, account) };
}

// The real stages' shape: two stages with one environment, one with three, and one environment
// with two domain accounts, so every loop is exercised.
export const FIXTURE_STAGES = [
  {
    name: "platform-dev",
    shared: { account: "100000000001" },
    environments: [
      {
        name: "sandbox",
        domainAccounts: [
          {
            name: "main",
            account: "100000000003",
            zone: zone("sandbox", "100000000003"),
          },
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
          {
            name: "main",
            account: "200000000003",
            zone: zone("sandbox", "200000000003"),
          },
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
          {
            name: "main",
            account: "300000000003",
            zone: zone("dev", "300000000003"),
          },
        ],
        frontdoor: frontdoor("dev", "300000000002"),
      },
      {
        name: "staging",
        domainAccounts: [
          {
            name: "main",
            account: "300000000005",
            zone: zone("staging", "300000000005"),
          },
        ],
        frontdoor: frontdoor("staging", "300000000004"),
      },
      {
        name: "prod",
        domainAccounts: [
          {
            name: "main",
            account: "300000000007",
            zone: zone("prod", "300000000007"),
          },
          {
            name: "second",
            account: "300000000008",
            zone: zone("prod", "300000000008"),
          },
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
