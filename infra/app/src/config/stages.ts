import type { TrustedIssuer } from "@repo/frontdoor-shared";

import type { NetworkConfig, StageConfig } from "./types.ts";

const STAGING_POOL: TrustedIssuer = {
  issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_2d00uk68K",
  clientIds: ["7r88bunbmdsvihr2cdb43lasun"],
};

const PRODUCTION_POOL: TrustedIssuer = {
  issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_vn7u4bWbc",
  clientIds: ["40grlhknon5palderi2j1a1bte"],
};

// A NAT gateway is per availability zone, so the stages that only the platform team uses run in
// two. The environments domain teams use run in all three.
const TWO_ZONES: NetworkConfig = {
  availabilityZones: ["eu-west-2a", "eu-west-2b"],
};

const THREE_ZONES: NetworkConfig = {
  availabilityZones: ["eu-west-2a", "eu-west-2b", "eu-west-2c"],
};

// The development environments trust the staging pool until they have a test pool of their own.
export const STAGES: readonly StageConfig[] = [
  {
    name: "platform-dev",
    shared: { account: "743702012480" },
    environments: [
      {
        name: "development",
        domainAccounts: [
          {
            name: "domain00",
            account: "098640806149",
            domains: ["example"],
            zone: {
              name: "development.flex-platform.once.service.gov.uk",
              id: "Z0835542Q6J8ILWJ1RGR",
            },
            network: TWO_ZONES,
            gateways: [],
          },
        ],
        frontdoor: {
          account: "553915472156",
          zone: {
            name: "development.flex-platformedge.once.service.gov.uk",
            id: "Z031433615ESLO5K1AH7F",
          },
          issuers: [STAGING_POOL],
        },
      },
    ],
  },
  {
    name: "platform-staging",
    shared: { account: "186579591752" },
    environments: [
      {
        name: "staging",
        domainAccounts: [
          {
            name: "domain00",
            account: "179512357753",
            domains: [],
            zone: {
              name: "staging.flex-platform.once.service.gov.uk",
              id: "Z0085548AFKTJHKTHK3P",
            },
            network: TWO_ZONES,
            gateways: [],
          },
        ],
        frontdoor: {
          account: "224399154937",
          zone: {
            name: "staging.flex-platformedge.once.service.gov.uk",
            id: "Z0462383HSDK7C8IQ6HN",
          },
          issuers: [STAGING_POOL],
        },
      },
    ],
  },
  {
    name: "platform-prod",
    shared: { account: "706098201385" },
    environments: [
      {
        name: "development",
        domainAccounts: [
          {
            name: "domain00",
            account: "168789041282",
            domains: [],
            zone: {
              name: "development.flex-domain00.once.service.gov.uk",
              id: "Z05812543BRVPCL728ND0",
            },
            network: THREE_ZONES,
            gateways: [],
          },
        ],
        frontdoor: {
          account: "991575850800",
          zone: {
            name: "development.flex-domainedge.once.service.gov.uk",
            id: "Z08635081XAI47LT6BSJQ",
          },
          issuers: [STAGING_POOL],
        },
      },
      {
        name: "staging",
        domainAccounts: [
          {
            name: "domain00",
            account: "187157282680",
            domains: [],
            zone: {
              name: "staging.flex-domain00.once.service.gov.uk",
              id: "Z02914492HOQJQ6UXSZ9B",
            },
            network: THREE_ZONES,
            gateways: [],
          },
        ],
        frontdoor: {
          account: "792037778504",
          zone: {
            name: "staging.flex-domainedge.once.service.gov.uk",
            id: "Z0490122CGGKQPL28DUH",
          },
          issuers: [STAGING_POOL],
        },
      },
      {
        name: "production",
        domainAccounts: [
          {
            name: "domain00",
            account: "105322542531",
            domains: [],
            zone: {
              name: "production.flex-domain00.once.service.gov.uk",
              id: "Z0411378AOM55J0BQQZI",
            },
            network: THREE_ZONES,
            gateways: [],
          },
        ],
        frontdoor: {
          account: "367273783987",
          zone: {
            name: "production.flex-domainedge.once.service.gov.uk",
            id: "Z04221372NJE375QTYYDR",
          },
          issuers: [PRODUCTION_POOL],
        },
      },
    ],
  },
];
