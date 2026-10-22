import type { TrustedIssuer } from "@repo/frontdoor-shared";

import { example } from "./domains/example.ts";
import type { StageConfig } from "./types.ts";

const STAGING_POOL: TrustedIssuer = {
  issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_2d00uk68K",
  clientIds: ["7r88bunbmdsvihr2cdb43lasun"],
};

const PRODUCTION_POOL: TrustedIssuer = {
  issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_vn7u4bWbc",
  clientIds: ["40grlhknon5palderi2j1a1bte"],
};

// The development environments trust the staging pool until they have a test pool of their own.
export const STAGES: readonly StageConfig[] = [
  {
    name: "platform-dev",
    shared: { account: "743702012480" },
    environments: [
      {
        name: "development",
        domains: [example],
        frontdoor: {
          account: "553915472156",
          zone: {
            name: "development.flex-platformedge.once.service.gov.uk",
            id: "Z031433615ESLO5K1AH7F",
          },
          issuers: [STAGING_POOL],
        },
        domainAccounts: [
          {
            name: "domain00",
            account: "098640806149",
            zone: {
              name: "development.flex-platform.once.service.gov.uk",
              id: "Z0835542Q6J8ILWJ1RGR",
            },
            network: {
              isolated: {
                subnetIds: [
                  "subnet-09131014f73267f2c",
                  "subnet-04f2d2758b5632297",
                  "subnet-0005b9565e5ef0f93",
                ],
                // Placeholder: Replace with the ID of the security group for domains in the VPC.
                securityGroupId: "sg-00000000000000000",
              },
            },
          },
        ],
      },
    ],
  },
  {
    name: "platform-staging",
    shared: { account: "186579591752" },
    environments: [
      {
        name: "staging",
        domains: [],
        frontdoor: {
          account: "224399154937",
          zone: {
            name: "staging.flex-platformedge.once.service.gov.uk",
            id: "Z0462383HSDK7C8IQ6HN",
          },
          issuers: [STAGING_POOL],
        },
        domainAccounts: [
          {
            name: "domain00",
            account: "179512357753",
            zone: {
              name: "staging.flex-platform.once.service.gov.uk",
              id: "Z0085548AFKTJHKTHK3P",
            },
            network: {},
          },
        ],
      },
    ],
  },
  {
    name: "platform-prod",
    shared: { account: "706098201385" },
    environments: [
      {
        name: "development",
        domains: [],
        frontdoor: {
          account: "991575850800",
          zone: {
            name: "development.flex-domainedge.once.service.gov.uk",
            id: "Z08635081XAI47LT6BSJQ",
          },
          issuers: [STAGING_POOL],
        },
        domainAccounts: [
          {
            name: "domain00",
            account: "168789041282",
            zone: {
              name: "development.flex-domain00.once.service.gov.uk",
              id: "Z05812543BRVPCL728ND0",
            },
            network: {},
          },
        ],
      },
      {
        name: "staging",
        domains: [],
        frontdoor: {
          account: "792037778504",
          zone: {
            name: "staging.flex-domainedge.once.service.gov.uk",
            id: "Z0490122CGGKQPL28DUH",
          },
          issuers: [STAGING_POOL],
        },
        domainAccounts: [
          {
            name: "domain00",
            account: "187157282680",
            zone: {
              name: "staging.flex-domain00.once.service.gov.uk",
              id: "Z02914492HOQJQ6UXSZ9B",
            },
            network: {},
          },
        ],
      },
      {
        name: "production",
        domains: [],
        frontdoor: {
          account: "367273783987",
          zone: {
            name: "production.flex-domainedge.once.service.gov.uk",
            id: "Z04221372NJE375QTYYDR",
          },
          issuers: [PRODUCTION_POOL],
        },
        domainAccounts: [
          {
            name: "domain00",
            account: "105322542531",
            zone: {
              name: "production.flex-domain00.once.service.gov.uk",
              id: "Z0411378AOM55J0BQQZI",
            },
            network: {},
          },
        ],
      },
    ],
  },
];
