import { describe, expect, it } from "vitest";

import {
  domainAccount,
  FIXTURE_STAGES,
  FRONTDOOR,
  GATEWAYS,
} from "../../test/helpers.ts";
import type {
  DomainAccountConfig,
  EnvironmentConfig,
  FrontdoorConfig,
  StageConfig,
  ZoneConfig,
} from "./types.ts";
import { validateStages } from "./validate.ts";

const MAIN_DOMAIN_ACCOUNT: DomainAccountConfig = {
  ...domainAccount("sandbox", "main", "100000000003"),
  domains: ["domain-a"],
};

const ENVIRONMENT: EnvironmentConfig = {
  name: "sandbox",
  domainAccounts: [MAIN_DOMAIN_ACCOUNT],
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
      domainAccounts: [domainAccount("prod", "main", "300000000003")],
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
      const domainAccounts = [domainAccount("sandbox", "Main", "100000000003")];
      expect(() =>
        validateStages([withEnvironment({ domainAccounts })]),
      ).toThrow('The platform-dev/sandbox domain account name "Main" must be');
    });

    it("refuses an environment name used twice in a stage", () => {
      const second = {
        ...ENVIRONMENT,
        frontdoor: { ...FRONTDOOR, account: "100000000004" },
        domainAccounts: [domainAccount("sandbox", "main", "100000000005")],
      };
      expect(() =>
        validateStages([{ ...STAGE, environments: [ENVIRONMENT, second] }]),
      ).toThrow(
        "The platform-dev environment name sandbox is used more than once",
      );
    });

    it("refuses a domain account name used twice in an environment", () => {
      const domainAccounts = [
        domainAccount("sandbox", "main", "100000000003"),
        domainAccount("sandbox", "main", "100000000004"),
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
        domainAccounts: [
          {
            ...MAIN_DOMAIN_ACCOUNT,
            zone: { ...MAIN_DOMAIN_ACCOUNT.zone, ...zone },
          },
        ],
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

  describe("domains", () => {
    function withDomains(
      domains: readonly string[],
      second: readonly string[] = [],
    ): StageConfig {
      return withEnvironment({
        domainAccounts: [
          { ...MAIN_DOMAIN_ACCOUNT, domains },
          {
            ...domainAccount("sandbox", "second", "100000000004"),
            domains: second,
          },
        ],
      });
    }

    it("accepts accounts with no domains", () => {
      expect(() => validateStages([withDomains([])])).not.toThrow();
    });

    it("refuses an invalid domain name", () => {
      expect(() => validateStages([withDomains(["Domain-A"])])).toThrow(
        'The platform-dev/sandbox domain name "Domain-A" must be',
      );
    });

    it("refuses a domain name used twice in an environment, even in two accounts", () => {
      expect(() =>
        validateStages([withDomains(["domain-a"], ["domain-a"])]),
      ).toThrow(
        "The platform-dev/sandbox domain name domain-a is used more than once",
      );
    });

    it("keeps the domain's function name within Lambda's limit", () => {
      const environment = "e".repeat(32);
      const fits = "d".repeat(64 - 32 - "domain--".length);

      const stage = (name: string): StageConfig => ({
        ...STAGE,
        environments: [
          {
            ...ENVIRONMENT,
            name: environment,
            domainAccounts: [{ ...MAIN_DOMAIN_ACCOUNT, domains: [name] }],
          },
        ],
      });

      expect(() => validateStages([stage(fits)])).not.toThrow();
      expect(() => validateStages([stage(`${fits}d`)])).toThrow(
        `platform-dev/${environment} ${fits}d domain: its function name domain-${environment}-${fits}d is longer than Lambda's 64 characters`,
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
      const domainAccounts = [domainAccount("sandbox", "main", "10000000003")];
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
        domainAccount("sandbox", "main", "100000000003"),
        domainAccount("sandbox", "second", "100000000003"),
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
        domainAccounts: [domainAccount("sandbox", "main", "100000000003")],
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

  describe("networks", () => {
    function withZones(availabilityZones: readonly string[]): StageConfig {
      return withEnvironment({
        domainAccounts: [
          { ...MAIN_DOMAIN_ACCOUNT, network: { availabilityZones } },
        ],
      });
    }

    it.each([
      [["eu-west-2a", "eu-west-2b"]],
      [["eu-west-2c", "eu-west-2a", "eu-west-2b"]],
    ])("accepts the zones %j", (zones) => {
      expect(() => validateStages([withZones(zones)])).not.toThrow();
    });

    it.each([
      [["eu-west-2a"], "at least 2 availability zones"],
      [["eu-west-2a", "eu-west-2a"], "listed twice"],
      [
        ["eu-west-2a", "eu-west-1a"],
        '"eu-west-1a" is not an availability zone',
      ],
    ])("refuses the zones %j", (zones, message) => {
      expect(() => validateStages([withZones(zones)])).toThrow(
        `platform-dev/sandbox main domain account network: `,
      );
      expect(() => validateStages([withZones(zones)])).toThrow(message);
    });
  });

  describe("gateways", () => {
    function withGateways(
      gateways: DomainAccountConfig["gateways"],
    ): StageConfig {
      return withEnvironment({
        domainAccounts: [{ ...MAIN_DOMAIN_ACCOUNT, gateways }],
      });
    }

    const UDP = GATEWAYS[0]!;

    it("accepts an account with no gateways", () => {
      expect(() => validateStages([withGateways([])])).not.toThrow();
    });

    it("refuses a gateway id used twice in an account", () => {
      expect(() => validateStages([withGateways([UDP, UDP])])).toThrow(
        "The platform-dev/sandbox main domain account gateway name udp is used more than once",
      );
    });

    it("refuses a gateway id that isn't a platform name", () => {
      expect(() =>
        validateStages([withGateways([{ ...UDP, id: "UDP" }])]),
      ).toThrow('gateway name "UDP" must be');
    });

    it("refuses a gateway whose function name would be too long", () => {
      const id = `g${"a".repeat(31)}`;
      const environment = `e${"b".repeat(31)}`;
      expect(() =>
        validateStages([
          {
            ...STAGE,
            environments: [
              {
                ...ENVIRONMENT,
                name: environment,
                domainAccounts: [
                  { ...MAIN_DOMAIN_ACCOUNT, gateways: [{ ...UDP, id }] },
                ],
              },
            ],
          },
        ]),
      ).toThrow("is longer than Lambda's 64 characters");
    });

    it("refuses a gateway that names no hostname", () => {
      expect(() =>
        validateStages([withGateways([{ ...UDP, hostnames: [] }])]),
      ).toThrow("udp gateway: it names no hostname");
    });

    it.each([
      ["https://api.udp.example/v1", "is a URL"],
      ["api.udp.example:443", "has a port"],
      ["192.0.2.10", "is an IP address"],
    ])("refuses the hostname %j", (hostname, why) => {
      expect(() =>
        validateStages([withGateways([{ ...UDP, hostnames: [hostname] }])]),
      ).toThrow(
        `platform-dev/sandbox main domain account udp gateway: ${JSON.stringify(hostname)} is not a hostname: it ${why}`,
      );
    });

    it("refuses a wildcard, however narrow", () => {
      expect(() =>
        validateStages([
          withGateways([{ ...UDP, hostnames: ["*.regions.cdn.example.net"] }]),
        ]),
      ).toThrow("is a wildcard; list each name exactly");
    });
  });
});
