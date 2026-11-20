import * as domains from "./domains.ts";
import type { StageConfig } from "./types.ts";
import * as userPools from "./user-pools.ts";
import * as zones from "./zones.ts";

// Every stage and its environments. Each domain is defined once, in domains.ts, and listed by the
// domain accounts that host it.
//
// A NAT gateway is per availability zone, so the stages that only the platform team uses run in
// two. The environments domain teams use run in all three.
export const STAGES: readonly StageConfig[] = [
  {
    name: "platform-dev",
    shared: {
      account: "743702012480",
      zone: zones.DEVELOPMENT_FLEX_SHARED,
    },
    environments: [
      {
        name: "development",
        release: "publish",
        domainAccounts: [
          {
            name: "domain00",
            account: "098640806149",
            domains: [domains.example],
            zone: zones.DEVELOPMENT_FLEX_PLATFORM,
            network: { availabilityZones: ["eu-west-2a", "eu-west-2b"] },
            gateways: [],
          },
        ],
        frontdoor: {
          account: "553915472156",
          zone: zones.DEVELOPMENT_FLEX_PLATFORMEDGE,
          issuers: [],
          testUserIssuer: userPools.PLATFORM_DEV_TEST_USERS,
        },
      },
    ],
  },
  {
    name: "platform-staging",
    shared: {
      account: "186579591752",
      zone: zones.STAGING_FLEX_SHARED,
    },
    environments: [
      {
        name: "staging",
        release: "publish",
        domainAccounts: [
          {
            name: "domain00",
            account: "179512357753",
            domains: [],
            zone: zones.STAGING_FLEX_PLATFORM,
            network: { availabilityZones: ["eu-west-2a", "eu-west-2b"] },
            gateways: [],
          },
        ],
        frontdoor: {
          account: "224399154937",
          zone: zones.STAGING_FLEX_PLATFORMEDGE,
          issuers: [userPools.STAGING],
          testUserIssuer: null,
        },
      },
    ],
  },
  {
    name: "platform-prod",
    shared: {
      account: "706098201385",
      zone: zones.PRODUCTION_FLEX_SHARED,
    },
    environments: [
      {
        name: "development",
        release: "publish",
        domainAccounts: [
          {
            name: "domain00",
            account: "168789041282",
            domains: [],
            zone: zones.DEVELOPMENT_FLEX_DOMAIN00,
            network: {
              availabilityZones: ["eu-west-2a", "eu-west-2b", "eu-west-2c"],
            },
            gateways: [],
          },
        ],
        frontdoor: {
          account: "991575850800",
          zone: zones.DEVELOPMENT_FLEX_DOMAINEDGE,
          // The staging pool, until this environment has a test pool of its own.
          issuers: [userPools.STAGING],
          testUserIssuer: null,
        },
      },
      {
        name: "staging",
        release: { promoteFrom: "development" },
        domainAccounts: [
          {
            name: "domain00",
            account: "187157282680",
            domains: [],
            zone: zones.STAGING_FLEX_DOMAIN00,
            network: {
              availabilityZones: ["eu-west-2a", "eu-west-2b", "eu-west-2c"],
            },
            gateways: [],
          },
        ],
        frontdoor: {
          account: "792037778504",
          zone: zones.STAGING_FLEX_DOMAINEDGE,
          issuers: [userPools.STAGING],
          testUserIssuer: null,
        },
      },
      {
        name: "production",
        release: { promoteFrom: "staging" },
        domainAccounts: [
          {
            name: "domain00",
            account: "105322542531",
            domains: [],
            zone: zones.PRODUCTION_FLEX_DOMAIN00,
            network: {
              availabilityZones: ["eu-west-2a", "eu-west-2b", "eu-west-2c"],
            },
            gateways: [],
          },
        ],
        frontdoor: {
          account: "367273783987",
          zone: zones.PRODUCTION_FLEX_DOMAINEDGE,
          issuers: [userPools.PRODUCTION],
          testUserIssuer: null,
        },
      },
    ],
  },
];
