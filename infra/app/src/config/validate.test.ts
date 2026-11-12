import { describe, expect, it } from "vitest";

import {
  domainAccount,
  FIXTURE_STAGES,
  FRONTDOOR,
  OWN_SECRET_GATEWAY,
  REPOSITORY,
  shared,
  TEST_USERS,
  UDP,
} from "../../test/helpers.ts";
import { domainName } from "./domain-name.ts";
import type {
  DomainAccountConfig,
  DomainConfig,
  EnvironmentConfig,
  FrontdoorConfig,
  RepositoryConfig,
  StageConfig,
  StageDomainConfig,
  ZoneConfig,
} from "./types.ts";
import { validateStages } from "./validate.ts";

const MAIN_DOMAIN_ACCOUNT: DomainAccountConfig = {
  ...domainAccount("sandbox", "main", "100000000003"),
  domains: ["domain-a"],
};

const ENVIRONMENT: EnvironmentConfig = {
  name: "sandbox",
  release: "publish",
  domainAccounts: [MAIN_DOMAIN_ACCOUNT],
  frontdoor: FRONTDOOR,
};

const STAGE: StageConfig = {
  name: "platform-dev",
  shared: shared("100000000001"),
  domains: [{ name: "domain-a", repository: null }],
  environments: [ENVIRONMENT],
};

// A second stage with accounts of its own, to put beside STAGE.
const OTHER_STAGE: StageConfig = {
  name: "platform-prod",
  shared: shared("300000000001"),
  domains: [],
  environments: [
    {
      name: "prod",
      release: "publish",
      domainAccounts: [domainAccount("prod", "main", "300000000003")],
      frontdoor: { ...FRONTDOOR, account: "300000000002" },
    },
  ],
};

// The domains the environments host, each once and with no repository, so a test that changes
// what is hosted keeps the stage's own list in step with it.
function hostedDomains(
  environments: readonly EnvironmentConfig[],
): StageDomainConfig[] {
  const names = new Set(
    environments.flatMap(({ domainAccounts }) =>
      domainAccounts.flatMap(({ domains }) => domains.map(domainName)),
    ),
  );
  return [...names].map((name) => ({ name, repository: null }));
}

function withEnvironments(
  environments: readonly EnvironmentConfig[],
): StageConfig {
  return { ...STAGE, domains: hostedDomains(environments), environments };
}

function withEnvironment(environment: Partial<EnvironmentConfig>): StageConfig {
  return withEnvironments([{ ...ENVIRONMENT, ...environment }]);
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

    // It's the target that builds the shared account's stacks.
    it("refuses an environment named shared", () => {
      expect(() =>
        validateStages([withEnvironment({ name: "shared" })]),
      ).toThrow("platform-dev: no environment may be named shared");
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

    it("holds the shared account's zone to the same rules", () => {
      const withSharedZone = (zone: Partial<ZoneConfig>): StageConfig => ({
        ...STAGE,
        shared: { ...STAGE.shared, zone: { ...STAGE.shared.zone, ...zone } },
      });
      const name = `${"a".repeat(56)}.example`;

      expect(() => validateStages([withSharedZone({ name })])).not.toThrow();
      expect(() =>
        validateStages([withSharedZone({ name: "shared" })]),
      ).toThrow('platform-dev shared zone: "shared" must be a DNS name');
      expect(() => validateStages([withSharedZone({ id: "z1" })])).toThrow(
        'platform-dev shared zone: "z1" is not a hosted zone ID',
      );
      // The management distribution's certificate is for the apex, as the frontdoor's is.
      expect(() =>
        validateStages([withSharedZone({ name: `a${name}` })]),
      ).toThrow(
        `platform-dev shared zone: its certificate's name, a${name}, is longer than ACM's 64 characters`,
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

  describe("test users", () => {
    const WITH_POOL: StageConfig = {
      ...STAGE,
      shared: { ...STAGE.shared, testUsers: TEST_USERS },
    };

    function trusting(
      stage: StageConfig,
      frontdoor: Partial<FrontdoorConfig>,
    ): StageConfig {
      return {
        ...stage,
        environments: [
          { ...ENVIRONMENT, frontdoor: { ...FRONTDOOR, ...frontdoor } },
        ],
      };
    }

    it("accepts an environment that trusts its stage's test users", () => {
      expect(() =>
        validateStages([trusting(WITH_POOL, { testUsers: true })]),
      ).not.toThrow();
    });

    it("accepts an environment that trusts test users alone", () => {
      expect(() =>
        validateStages([trusting(WITH_POOL, { issuers: [], testUsers: true })]),
      ).not.toThrow();
    });

    it("holds a stage's test user pool to the rule every issuer is held to", () => {
      const http = { ...TEST_USERS, issuer: "http://example" };
      expect(() =>
        validateStages([
          { ...STAGE, shared: { ...STAGE.shared, testUsers: http } },
        ]),
      ).toThrow(
        'platform-dev shared test users: the issuer "http://example" must be an https URL',
      );

      const noClient = { ...TEST_USERS, clientIds: [] };
      expect(() =>
        validateStages([
          { ...STAGE, shared: { ...STAGE.shared, testUsers: noClient } },
        ]),
      ).toThrow(
        `platform-dev shared test users: the issuer ${TEST_USERS.issuer} names no app client`,
      );
    });

    it("refuses its stage's test user pool in an environment's issuers", () => {
      expect(() =>
        validateStages([
          trusting(WITH_POOL, { issuers: [...FRONTDOOR.issuers, TEST_USERS] }),
        ]),
      ).toThrow(
        `platform-dev/sandbox: the issuer ${TEST_USERS.issuer} is a test user pool, which an environment trusts only through frontdoor.testUsers`,
      );
    });

    it("refuses another stage's test user pool in an environment's issuers", () => {
      const other: StageConfig = {
        ...OTHER_STAGE,
        shared: { ...OTHER_STAGE.shared, testUsers: TEST_USERS },
      };
      expect(() =>
        validateStages([
          trusting(STAGE, { issuers: [...FRONTDOOR.issuers, TEST_USERS] }),
          other,
        ]),
      ).toThrow(
        `platform-dev/sandbox: the issuer ${TEST_USERS.issuer} is a test user pool`,
      );
    });

    it("refuses trust in test users where the stage has no pool", () => {
      expect(() =>
        validateStages([trusting(STAGE, { testUsers: true })]),
      ).toThrow(
        "platform-dev/sandbox: the frontdoor trusts test users, but platform-dev names no test user pool",
      );
    });

    it("needs an issuer when the environment doesn't trust test users", () => {
      expect(() =>
        validateStages([trusting(WITH_POOL, { issuers: [] })]),
      ).toThrow(
        "platform-dev/sandbox: the frontdoor needs at least one trusted issuer",
      );
    });
  });

  describe("domains", () => {
    function withDomains(
      domains: readonly DomainConfig[],
      second: readonly DomainConfig[] = [],
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

    it("refuses a name a disabled domain holds, since it keeps its stack", () => {
      expect(() =>
        validateStages([
          withDomains(["domain-a"], [{ name: "domain-a", disabled: true }]),
        ]),
      ).toThrow(
        "The platform-dev/sandbox domain name domain-a is used more than once",
      );
    });

    it("checks a disabled domain's name as any other", () => {
      expect(() =>
        validateStages([withDomains([{ name: "Domain-A", disabled: true }])]),
      ).toThrow('The platform-dev/sandbox domain name "Domain-A" must be');
    });

    it("keeps the domain's execution role's name within IAM's limit, disabled or not", () => {
      const environment = "e".repeat(32);
      const fits = "d".repeat(64 - 32 - "domain---execution".length);

      const stage = (name: string): StageConfig =>
        withEnvironments([
          {
            ...ENVIRONMENT,
            name: environment,
            domainAccounts: [
              { ...MAIN_DOMAIN_ACCOUNT, domains: [{ name, disabled: true }] },
            ],
          },
        ]);

      expect(() => validateStages([stage(fits)])).not.toThrow();
      expect(() => validateStages([stage(`${fits}d`)])).toThrow(
        `platform-dev/${environment} ${fits}d domain: its execution role's name domain-${environment}-${fits}d-execution is longer than IAM's 64 characters`,
      );
    });
  });

  describe("a stage's domains", () => {
    function withStageDomains(
      domains: readonly StageDomainConfig[],
    ): StageConfig {
      return { ...STAGE, domains };
    }

    function withRepository(
      repository: Partial<RepositoryConfig>,
    ): StageConfig {
      return withStageDomains([
        { name: "domain-a", repository: { ...REPOSITORY, ...repository } },
      ]);
    }

    it("accepts a domain with a repository, and one with none yet", () => {
      expect(() => validateStages([withRepository({})])).not.toThrow();
      expect(() =>
        validateStages([
          withStageDomains([{ name: "domain-a", repository: null }]),
        ]),
      ).not.toThrow();
    });

    it("refuses a hosted domain the stage doesn't list, disabled or not", () => {
      expect(() => validateStages([withStageDomains([])])).toThrow(
        "platform-dev/sandbox: the domain domain-a is not in platform-dev's domains, which say who may release it",
      );

      const disabled: StageConfig = {
        ...STAGE,
        domains: [],
        environments: [
          {
            ...ENVIRONMENT,
            domainAccounts: [
              {
                ...MAIN_DOMAIN_ACCOUNT,
                domains: [{ name: "domain-a", disabled: true }],
              },
            ],
          },
        ],
      };
      expect(() => validateStages([disabled])).toThrow(
        "platform-dev/sandbox: the domain domain-a is not in platform-dev's domains",
      );
    });

    // Its repository would stay trusted to upload code for a domain the stage no longer has.
    it("refuses a listed domain that no environment hosts", () => {
      expect(() =>
        validateStages([
          withStageDomains([
            { name: "domain-a", repository: null },
            { name: "domain-b", repository: REPOSITORY },
          ]),
        ]),
      ).toThrow(
        "platform-dev: the domain domain-b is in its domains, but no environment hosts it",
      );
    });

    it("refuses a domain listed twice", () => {
      expect(() =>
        validateStages([
          withStageDomains([
            { name: "domain-a", repository: null },
            { name: "domain-a", repository: REPOSITORY },
          ]),
        ]),
      ).toThrow("The platform-dev domain name domain-a is used more than once");
    });

    it.each(["example-org/domain-a", "a/b", "Example-Org/Domain.A_1"])(
      "accepts the repository %j",
      (name) => {
        expect(() => validateStages([withRepository({ name })])).not.toThrow();
      },
    );

    it.each([
      "",
      "domain-a",
      "example-org/",
      "/domain-a",
      "example-org/domain-a/extra",
      "example_org/domain-a",
      "https://github.com/example-org/domain-a",
      "example-org/domain a",
    ])("refuses the repository %j", (name) => {
      expect(() => validateStages([withRepository({ name })])).toThrow(
        `platform-dev domain-a domain: its repository ${JSON.stringify(name)} must be <owner>/<repository>`,
      );
    });

    // A token's claim holds the ID in digits, so anything else would never match one.
    it.each(["", "0", "0123", "12a", " 123", "1.5", "-1"])(
      "refuses the ID %j",
      (id) => {
        expect(() => validateStages([withRepository({ id })])).toThrow(
          `platform-dev domain-a domain: its repository's ID ${JSON.stringify(id)} must be digits`,
        );
        expect(() => validateStages([withRepository({ ownerId: id })])).toThrow(
          `platform-dev domain-a domain: its repository's owner's ID ${JSON.stringify(id)} must be digits`,
        );
      },
    );
  });

  describe("release", () => {
    const [, , PROD] = FIXTURE_STAGES;
    const [DEV, STAGING, LIVE] = PROD.environments;

    function withProdEnvironments(
      environments: readonly EnvironmentConfig[],
    ): StageConfig {
      return { ...PROD, environments };
    }

    it("accepts environments that promote one to the next from one that publishes", () => {
      expect(() => validateStages([PROD])).not.toThrow();
    });

    it("accepts a stage whose environments all publish", () => {
      expect(() =>
        validateStages([
          withProdEnvironments([
            DEV,
            { ...STAGING, release: "publish" },
            { ...LIVE, release: "publish" },
          ]),
        ]),
      ).not.toThrow();
    });

    it.each(["production", "", "platform-prod"])(
      "refuses a promotion from %j, which the stage doesn't have",
      (promoteFrom) => {
        expect(() =>
          validateStages([
            withProdEnvironments([
              DEV,
              { ...STAGING, release: { promoteFrom } },
              LIVE,
            ]),
          ]),
        ).toThrow(
          `platform-prod/staging: it promotes from ${JSON.stringify(promoteFrom)}, which must be another environment of platform-prod`,
        );
      },
    );

    it("refuses an environment that promotes from itself", () => {
      expect(() =>
        validateStages([
          withProdEnvironments([
            DEV,
            { ...STAGING, release: { promoteFrom: "staging" } },
            LIVE,
          ]),
        ]),
      ).toThrow(
        'platform-prod/staging: it promotes from "staging", which must be another environment of platform-prod',
      );
    });

    it("refuses promotions that never reach an environment that publishes", () => {
      expect(() =>
        validateStages([
          withProdEnvironments([
            { ...DEV, release: { promoteFrom: "prod" } },
            STAGING,
            LIVE,
          ]),
        ]),
      ).toThrow(
        "platform-prod/dev: its promotions never reach an environment that publishes",
      );
    });

    it("refuses a domain that isn't hosted where it would be promoted from, disabled or not", () => {
      const [main, second] = LIVE.domainAccounts;
      const live = (domain: DomainConfig): EnvironmentConfig => ({
        ...LIVE,
        domainAccounts: [main, { ...second, domains: [domain] }],
      });
      const stage = (domain: DomainConfig): StageConfig => ({
        ...withProdEnvironments([DEV, STAGING, live(domain)]),
        domains: [...PROD.domains, { name: "domain-c", repository: null }],
      });

      expect(() => validateStages([stage("domain-c")])).toThrow(
        "platform-prod/prod: the domain domain-c is not hosted in staging, which it would be promoted from",
      );
      expect(() =>
        validateStages([stage({ name: "domain-c", disabled: true })]),
      ).toThrow(
        "platform-prod/prod: the domain domain-c is not hosted in staging",
      );
    });
  });

  describe("accounts", () => {
    it.each(["12345678901", "1234567890123", "12345678901a", " 100000000001"])(
      "refuses the account ID %j",
      (sharedAccount) => {
        expect(() =>
          validateStages([
            { ...STAGE, shared: { ...STAGE.shared, account: sharedAccount } },
          ]),
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
        shared: {
          ...OTHER_STAGE.shared,
          account: ENVIRONMENT.frontdoor.account,
        },
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
      ).toThrow(
        `platform-dev/${environment} main domain account ${id} gateway: The function name gateway-${environment}-${id} is longer than Lambda's 64 characters.`,
      );
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

    it("accepts a gateway that creates its own secret", () => {
      expect(() =>
        validateStages([withGateways([OWN_SECRET_GATEWAY])]),
      ).not.toThrow();
    });

    const SECRET = {
      arn: "arn:aws:secretsmanager:eu-west-2:200000000001:secret:udp/flex/consumer-AbCdEf",
      keyArn:
        "arn:aws:kms:eu-west-2:200000000001:key/00000000-0000-4000-8000-000000000000",
    };

    it.each([
      [
        "arn:aws:secretsmanager:eu-west-2:200000000001:secret:udp/flex/consumer",
        "without the characters Secrets Manager adds",
      ],
      [
        "arn:aws:secretsmanager:eu-west-1:200000000001:secret:udp/flex/consumer-AbCdEf",
        "in another region",
      ],
      [
        "arn:aws:secretsmanager:eu-west-2:200000000001:secret:udp/*",
        "with a wildcard",
      ],
    ])("refuses the secret ARN %j, %s", (arn) => {
      expect(() =>
        validateStages([
          withGateways([{ ...UDP, secret: { ...SECRET, arn } }]),
        ]),
      ).toThrow(
        `udp gateway: ${JSON.stringify(arn)} is not a secret's full ARN in eu-west-2`,
      );
    });

    it.each([
      "arn:aws:kms:eu-west-2:200000000001:alias/udp",
      "arn:aws:kms:eu-west-1:200000000001:key/00000000-0000-4000-8000-000000000000",
    ])("refuses the key ARN %j", (keyArn) => {
      expect(() =>
        validateStages([
          withGateways([{ ...UDP, secret: { ...SECRET, keyArn } }]),
        ]),
      ).toThrow(
        `udp gateway: ${JSON.stringify(keyArn)} is not a KMS key's ARN`,
      );
    });

    it("accepts a multi-region key", () => {
      const keyArn = `arn:aws:kms:eu-west-2:200000000001:key/mrk-${"0".repeat(32)}`;
      expect(() =>
        validateStages([
          withGateways([{ ...UDP, secret: { ...SECRET, keyArn } }]),
        ]),
      ).not.toThrow();
    });

    it.each([
      "arn:aws:iam::200000000001:role/*",
      "arn:aws:iam::200000000001:user/udp",
      "udp-flex-consumer",
    ])("refuses the role ARN %j", (arn) => {
      expect(() =>
        validateStages([withGateways([{ ...UDP, roleArns: [arn] }])]),
      ).toThrow(`udp gateway: ${JSON.stringify(arn)} is not a role's ARN`);
    });

    it("refuses a role listed twice", () => {
      expect(() =>
        validateStages([
          withGateways([
            { ...UDP, roleArns: [...UDP.roleArns, ...UDP.roleArns] },
          ]),
        ]),
      ).toThrow("udp gateway: a role ARN is listed more than once");
    });

    it("refuses an empty target, which would read as none", () => {
      expect(() =>
        validateStages([withGateways([{ ...UDP, target: "" }])]),
      ).toThrow("udp gateway: its target is empty; use null for none");
    });

    it("refuses a gateway whose role name would be too long", () => {
      const environment = `e${"b".repeat(19)}`;
      const id = `g${"a".repeat(31)}`;
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
      ).toThrow("is longer than IAM's 64 characters.");
    });
  });
});
