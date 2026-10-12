import { describe, expect, it } from "vitest";

import {
  DOMAIN_ONE,
  DOMAIN_TWO,
  FIXTURE_STAGES,
  FRONTDOOR,
  NETWORK,
  zone,
} from "../../test/helpers.ts";
import { STAGES } from "./stages.ts";
import type {
  DomainAccountConfig,
  EnvironmentConfig,
  FrontdoorConfig,
  HostedDomainConfig,
  StageConfig,
  ZoneConfig,
} from "./types.ts";
import { validateStages } from "./validate.ts";

function domainAccount(
  name: string,
  account: string,
  environment = "sandbox",
): DomainAccountConfig {
  return { name, account, zone: zone(environment, account), network: NETWORK };
}

const MAIN = domainAccount("main", "100000000003");

const ENVIRONMENT: EnvironmentConfig = {
  name: "sandbox",
  domainAccounts: [MAIN],
  domains: [DOMAIN_ONE],
  frontdoor: FRONTDOOR,
};

const STAGE: StageConfig = {
  name: "platform-dev",
  shared: { account: "100000000001" },
  environments: [ENVIRONMENT],
};

// A second stage with accounts of its own, to put beside STAGE.
const OTHER_STAGE: StageConfig = {
  name: "platform-prod",
  shared: { account: "300000000001" },
  environments: [
    {
      name: "prod",
      domainAccounts: [domainAccount("main", "300000000003", "prod")],
      domains: [DOMAIN_ONE],
      frontdoor: { ...FRONTDOOR, account: "300000000002" },
    },
  ],
};

function withEnvironment(environment: Partial<EnvironmentConfig>): StageConfig {
  return { ...STAGE, environments: [{ ...ENVIRONMENT, ...environment }] };
}

function withFrontdoor(frontdoor: Partial<FrontdoorConfig>): StageConfig {
  return withEnvironment({ frontdoor: { ...FRONTDOOR, ...frontdoor } });
}

describe("validateStages", () => {
  it("accepts the fixture stages", () => {
    expect(() => validateStages(FIXTURE_STAGES)).not.toThrow();
  });

  it("accepts the committed stages", () => {
    expect(() => validateStages(STAGES)).not.toThrow();
  });

  describe("names", () => {
    const LONGEST = `a${"b".repeat(31)}`;

    it.each(["d", "d1", "dev-1", LONGEST])("accepts the name %j", (name) => {
      expect(() => validateStages([{ ...STAGE, name }])).not.toThrow();
    });

    it.each([
      "",
      `${LONGEST}c`,
      "Platform-Dev",
      "platform_dev",
      "platform.dev",
      "1dev",
      "-dev",
      "dev-",
    ])("refuses the stage name %j", (name) => {
      expect(() => validateStages([{ ...STAGE, name }])).toThrow(
        `The stage name ${JSON.stringify(name)} must be 1 to 32 lowercase letters`,
      );
    });

    it("refuses a stage name used twice", () => {
      expect(() =>
        validateStages([STAGE, { ...OTHER_STAGE, name: STAGE.name }]),
      ).toThrow("The stage name platform-dev is used more than once");
    });

    it("refuses an invalid environment name", () => {
      expect(() =>
        validateStages([withEnvironment({ name: "Sandbox" })]),
      ).toThrow('The platform-dev environment name "Sandbox" must be');
    });

    it("refuses an invalid domain account name", () => {
      const domainAccounts = [domainAccount("Main", "100000000003")];
      expect(() =>
        validateStages([withEnvironment({ domainAccounts })]),
      ).toThrow('The platform-dev/sandbox domain account name "Main" must be');
    });

    it("refuses an environment name used twice in a stage", () => {
      const second = {
        ...ENVIRONMENT,
        frontdoor: { ...FRONTDOOR, account: "100000000004" },
        domainAccounts: [domainAccount("main", "100000000005")],
      };
      expect(() =>
        validateStages([{ ...STAGE, environments: [ENVIRONMENT, second] }]),
      ).toThrow(
        "The platform-dev environment name sandbox is used more than once",
      );
    });

    it("refuses a domain account name used twice in an environment", () => {
      const domainAccounts = [
        domainAccount("main", "100000000003"),
        domainAccount("main", "100000000004"),
      ];
      expect(() =>
        validateStages([withEnvironment({ domainAccounts })]),
      ).toThrow(
        "The platform-dev/sandbox domain account name main is used more than once",
      );
    });
  });

  describe("zones", () => {
    function withFrontdoorZone(zone: Partial<ZoneConfig>): StageConfig {
      return withFrontdoor({ zone: { ...FRONTDOOR.zone, ...zone } });
    }

    function withDomainZone(zone: Partial<ZoneConfig>): StageConfig {
      return withEnvironment({
        domainAccounts: [{ ...MAIN, zone: { ...MAIN.zone, ...zone } }],
      });
    }

    it.each(["dev.flex.example", "a.b", "x-1.y2.example"])(
      "accepts the name %j",
      (name) => {
        expect(() =>
          validateStages([withFrontdoorZone({ name })]),
        ).not.toThrow();
      },
    );

    it.each([
      "example",
      "Dev.flex.example",
      "dev..flex",
      "-dev.flex",
      "dev.flex.",
    ])("refuses the name %j", (name) => {
      expect(() => validateStages([withFrontdoorZone({ name })])).toThrow(
        `platform-dev/sandbox frontdoor zone: ${JSON.stringify(name)} must be a DNS name`,
      );
    });

    it.each(["/hostedzone/Z0411378AOM55J0BQQZI", "z0411378", "Z", ""])(
      "refuses the ID %j",
      (id) => {
        expect(() => validateStages([withDomainZone({ id })])).toThrow(
          `platform-dev/sandbox main domain account zone: ${JSON.stringify(id)} is not a hosted zone ID`,
        );
      },
    );

    // ACM's 64 characters: the apex itself for the frontdoor, the wildcard for a domain account.
    it("keeps the frontdoor's apex within a certificate's name", () => {
      const name = `${"a".repeat(56)}.example`;
      expect(name).toHaveLength(64);
      expect(() => validateStages([withFrontdoorZone({ name })])).not.toThrow();
      expect(() =>
        validateStages([withFrontdoorZone({ name: `a${name}` })]),
      ).toThrow(
        `platform-dev/sandbox frontdoor zone: its certificate's name, a${name}, is longer than ACM's 64 characters`,
      );
    });

    it("keeps a domain account's wildcard within a certificate's name", () => {
      const name = `${"a".repeat(54)}.example`;
      expect(`*.${name}`).toHaveLength(64);
      expect(() => validateStages([withDomainZone({ name })])).not.toThrow();
      expect(() =>
        validateStages([withDomainZone({ name: `a${name}` })]),
      ).toThrow(
        `platform-dev/sandbox main domain account zone: its certificate's name, *.a${name}, is longer than ACM's 64 characters`,
      );
    });
  });

  describe("the frontdoor", () => {
    it("needs an issuer", () => {
      expect(() => validateStages([withFrontdoor({ issuers: [] })])).toThrow(
        "platform-dev/sandbox: the frontdoor needs at least one trusted issuer",
      );
    });

    it("refuses an issuer that is not an https URL", () => {
      const issuers = [{ issuer: "http://example", clientIds: ["c"] }];
      expect(() => validateStages([withFrontdoor({ issuers })])).toThrow(
        'platform-dev/sandbox: the issuer "http://example" must be an https URL',
      );
    });

    it("refuses an issuer with no app client", () => {
      const issuers = [{ issuer: "https://example", clientIds: [] }];
      expect(() => validateStages([withFrontdoor({ issuers })])).toThrow(
        "platform-dev/sandbox: the issuer https://example names no app client",
      );
    });
  });

  describe("accounts", () => {
    it.each(["12345678901", "1234567890123", "12345678901a", " 100000000001"])(
      "refuses the account ID %j",
      (sharedAccount) => {
        expect(() =>
          validateStages([{ ...STAGE, shared: { account: sharedAccount } }]),
        ).toThrow(
          /platform-dev shared account: .* is not a 12-digit account ID/,
        );
      },
    );

    it("refuses a malformed frontdoor account ID", () => {
      expect(() =>
        validateStages([withFrontdoor({ account: "10000000002" })]),
      ).toThrow(
        'platform-dev/sandbox frontdoor account: "10000000002" is not a 12-digit account ID',
      );
    });

    it("refuses a malformed domain account ID", () => {
      const domainAccounts = [domainAccount("main", "10000000003")];
      expect(() =>
        validateStages([withEnvironment({ domainAccounts })]),
      ).toThrow(
        'platform-dev/sandbox main domain account: "10000000003" is not a 12-digit account ID',
      );
    });

    it("refuses an account used twice in a stage", () => {
      expect(() =>
        validateStages([withFrontdoor({ account: "100000000001" })]),
      ).toThrow(
        "platform-dev/sandbox frontdoor account: account 100000000001 is already the platform-dev shared account",
      );
    });

    it("refuses the same account as two domain accounts", () => {
      const domainAccounts = [
        domainAccount("main", "100000000003"),
        domainAccount("second", "100000000003"),
      ];
      expect(() =>
        validateStages([withEnvironment({ domainAccounts })]),
      ).toThrow(
        "platform-dev/sandbox second domain account: account 100000000003 is already the platform-dev/sandbox main domain account",
      );
    });

    it("refuses an account used in two environments", () => {
      const second: EnvironmentConfig = {
        ...ENVIRONMENT,
        name: "other",
        frontdoor: { ...FRONTDOOR, account: "100000000004" },
        domainAccounts: [domainAccount("main", "100000000003")],
      };
      expect(() =>
        validateStages([{ ...STAGE, environments: [ENVIRONMENT, second] }]),
      ).toThrow(
        "platform-dev/other main domain account: account 100000000003 is already the platform-dev/sandbox main domain account",
      );
    });

    it("refuses an account shared between stages", () => {
      const other: StageConfig = {
        ...OTHER_STAGE,
        shared: { account: ENVIRONMENT.frontdoor.account },
      };
      expect(() => validateStages([STAGE, other])).toThrow(
        "platform-prod shared account: account 100000000002 is already the platform-dev/sandbox frontdoor account",
      );
    });
  });

  describe("domain account networks", () => {
    function withNetwork(network: DomainAccountConfig["network"]): StageConfig {
      return withEnvironment({ domainAccounts: [{ ...MAIN, network }] });
    }

    it("accepts an account with no network when it hosts no domain in the VPC", () => {
      expect(() =>
        validateStages([
          withEnvironment({
            domainAccounts: [{ ...MAIN, network: {} }],
            domains: [],
          }),
        ]),
      ).not.toThrow();
    });

    it("refuses a malformed subnet ID, wherever the stage is built", () => {
      expect(() =>
        validateStages([
          withNetwork({
            isolated: {
              subnetIds: ["subnet-1"],
              securityGroupId: "sg-00000000000000001",
            },
          }),
        ]),
      ).toThrow(
        'platform-dev/sandbox main domain account network: "subnet-1" is not a subnet ID',
      );
    });

    it("refuses a placement with no subnets", () => {
      expect(() =>
        validateStages([
          withNetwork({
            isolated: {
              subnetIds: [],
              securityGroupId: "sg-00000000000000001",
            },
          }),
        ]),
      ).toThrow(
        "platform-dev/sandbox main domain account network: the isolated placement has no subnets",
      );
    });
  });

  describe("domains", () => {
    function withDomains(...domains: HostedDomainConfig[]): StageConfig {
      return withEnvironment({ domains });
    }

    it("accepts an environment that hosts no domains", () => {
      expect(() => validateStages([withDomains()])).not.toThrow();
    });

    it("refuses a domain whose domain account isn't in the environment", () => {
      expect(() => validateStages([withDomains(DOMAIN_TWO)])).toThrow(
        "platform-dev/sandbox: the domain-two domain's domain account, second, isn't in the environment",
      );
    });

    it("refuses a domain whose access level its account's network doesn't offer", () => {
      const privateDomain: HostedDomainConfig = {
        ...DOMAIN_ONE,
        config: { ...DOMAIN_ONE.config, access: "private" },
      };

      expect(() =>
        validateStages([
          withEnvironment({
            domainAccounts: [
              { ...MAIN, network: { isolated: NETWORK.isolated! } },
            ],
            domains: [privateDomain],
          }),
        ]),
      ).toThrow(
        "platform-dev/sandbox: the domain-one domain is private, and the main domain account's network has no private placement",
      );
    });

    it("refuses an isolated domain in an account with no network", () => {
      expect(() =>
        validateStages([
          withEnvironment({ domainAccounts: [{ ...MAIN, network: {} }] }),
        ]),
      ).toThrow(
        "platform-dev/sandbox: the domain-one domain is isolated, and the main domain account's network has no isolated placement",
      );
    });

    it("accepts a public domain in an account with no network", () => {
      const second = {
        ...domainAccount("second", "100000000004"),
        network: {},
      };

      expect(() =>
        validateStages([
          withEnvironment({
            domainAccounts: [MAIN, second],
            domains: [DOMAIN_ONE, DOMAIN_TWO],
          }),
        ]),
      ).not.toThrow();
    });

    it("refuses a domain listed twice in an environment", () => {
      expect(() =>
        validateStages([withDomains(DOMAIN_ONE, DOMAIN_ONE)]),
      ).toThrow(
        "The platform-dev/sandbox domain name domain-one is used more than once",
      );
    });

    it("checks each domain's config, wherever the stage is built", () => {
      const invalid: HostedDomainConfig = {
        ...DOMAIN_ONE,
        config: { ...DOMAIN_ONE.config, routes: [] },
      };

      expect(() =>
        validateStages([
          STAGE,
          {
            ...OTHER_STAGE,
            environments: [
              { ...OTHER_STAGE.environments[0]!, domains: [invalid] },
            ],
          },
        ]),
      ).toThrow("domain-one domain has no routes");
    });

    it("refuses a domain whose resource names would be too long in its environment", () => {
      const name = `d${"x".repeat(31)}`;
      const environment = "e".repeat(25);
      const long: HostedDomainConfig = {
        ...DOMAIN_ONE,
        config: { ...DOMAIN_ONE.config, name },
      };

      expect(() =>
        validateStages([
          withEnvironment({ name: environment, domains: [long] }),
        ]),
      ).toThrow(
        `${name} domain: its resource name, domain-${environment}-${name}, is longer than the 64 characters Lambda and IAM allow`,
      );
    });

    it("accepts one declaration listed in several environments", () => {
      expect(() => validateStages([STAGE, OTHER_STAGE])).not.toThrow();
    });

    it("refuses a domain declared twice, even with the same config", () => {
      const copy: HostedDomainConfig = { ...DOMAIN_ONE };

      expect(() =>
        validateStages([
          STAGE,
          {
            ...OTHER_STAGE,
            environments: [
              { ...OTHER_STAGE.environments[0]!, domains: [copy] },
            ],
          },
        ]),
      ).toThrow(
        "platform-prod/prod: the domain-one domain is declared more than once. Declare it once, and list that declaration in each environment that hosts it",
      );
    });
  });
});
