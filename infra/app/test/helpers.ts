import { readFileSync } from "node:fs";

import { App } from "aws-cdk-lib";

import type { FrontdoorConfig, StageConfig } from "../src/config/types.ts";

// The committed feature flags, which change what CDK generates. A test on CDK's defaults would
// check an app that is never deployed.
const CDK_JSON_CONTEXT = (
  JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as {
    context: Record<string, unknown>;
  }
).context;

export function cdkApp(context: Record<string, unknown> = {}): App {
  return new App({ context: { ...CDK_JSON_CONTEXT, ...context } });
}

export const FRONTDOOR: FrontdoorConfig = {
  issuers: [
    {
      issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_example",
      clientIds: ["example-app-client"],
    },
  ],
};

// The real stages' shape: two stages with one environment, one with three, and one environment
// with two domain accounts, so every loop is exercised.
export const FIXTURE_STAGES = [
  {
    name: "platform-dev",
    sharedAccount: "100000000001",
    environments: [
      {
        name: "sandbox",
        frontdoorAccount: "100000000002",
        domainAccounts: [{ name: "main", account: "100000000003" }],
        domainName: "sandbox.platform-dev.flex.example",
        frontdoor: FRONTDOOR,
      },
    ],
  },
  {
    name: "platform-staging",
    sharedAccount: "200000000001",
    environments: [
      {
        name: "sandbox",
        frontdoorAccount: "200000000002",
        domainAccounts: [{ name: "main", account: "200000000003" }],
        domainName: "sandbox.platform-staging.flex.example",
        frontdoor: FRONTDOOR,
      },
    ],
  },
  {
    name: "platform-prod",
    sharedAccount: "300000000001",
    environments: [
      {
        name: "dev",
        frontdoorAccount: "300000000002",
        domainAccounts: [{ name: "main", account: "300000000003" }],
        domainName: "dev.flex.example",
        frontdoor: FRONTDOOR,
      },
      {
        name: "staging",
        frontdoorAccount: "300000000004",
        domainAccounts: [{ name: "main", account: "300000000005" }],
        domainName: "staging.flex.example",
        frontdoor: FRONTDOOR,
      },
      {
        name: "prod",
        frontdoorAccount: "300000000006",
        domainAccounts: [
          { name: "main", account: "300000000007" },
          { name: "second", account: "300000000008" },
        ],
        domainName: "prod.flex.example",
        frontdoor: FRONTDOOR,
      },
    ],
  },
] as const satisfies readonly StageConfig[];
