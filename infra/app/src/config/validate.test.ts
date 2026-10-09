import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, FRONTDOOR } from "../../test/helpers.ts";
import type {
  EnvironmentConfig,
  FrontdoorConfig,
  StageConfig,
} from "./types.ts";
import { validateStages } from "./validate.ts";

const ENVIRONMENT: EnvironmentConfig = {
  name: "sandbox",
  frontdoorAccount: "100000000002",
  domainAccounts: [{ name: "main", account: "100000000003" }],
  domainName: "sandbox.platform-dev.flex.example",
  frontdoor: FRONTDOOR,
};

const STAGE: StageConfig = {
  name: "platform-dev",
  sharedAccount: "100000000001",
  environments: [ENVIRONMENT],
};

// A second stage with accounts of its own, to put beside STAGE.
const OTHER_STAGE: StageConfig = {
  name: "platform-prod",
  sharedAccount: "300000000001",
  environments: [
    {
      name: "prod",
      frontdoorAccount: "300000000002",
      domainAccounts: [{ name: "main", account: "300000000003" }],
      domainName: "prod.flex.example",
      frontdoor: FRONTDOOR,
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
      const domainAccounts = [{ name: "Main", account: "100000000003" }];
      expect(() =>
        validateStages([withEnvironment({ domainAccounts })]),
      ).toThrow('The platform-dev/sandbox domain account name "Main" must be');
    });

    it("refuses an environment name used twice in a stage", () => {
      const second = {
        ...ENVIRONMENT,
        frontdoorAccount: "100000000004",
        domainAccounts: [{ name: "main", account: "100000000005" }],
      };
      expect(() =>
        validateStages([{ ...STAGE, environments: [ENVIRONMENT, second] }]),
      ).toThrow(
        "The platform-dev environment name sandbox is used more than once",
      );
    });

    it("refuses a domain account name used twice in an environment", () => {
      const domainAccounts = [
        { name: "main", account: "100000000003" },
        { name: "main", account: "100000000004" },
      ];
      expect(() =>
        validateStages([withEnvironment({ domainAccounts })]),
      ).toThrow(
        "The platform-dev/sandbox domain account name main is used more than once",
      );
    });
  });

  describe("the environment's domain name", () => {
    it.each(["dev.flex.example", "a.b", "x-1.y2.example"])(
      "accepts %j",
      (domainName) => {
        expect(() =>
          validateStages([withEnvironment({ domainName })]),
        ).not.toThrow();
      },
    );

    it.each([
      "example",
      "Dev.flex.example",
      "dev..flex",
      "-dev.flex",
      "dev.flex.",
    ])("refuses %j", (domainName) => {
      expect(() => validateStages([withEnvironment({ domainName })])).toThrow(
        `platform-dev/sandbox: the domain name ${JSON.stringify(domainName)} must be`,
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

    it.each([9, 2_000_000_001, 100.5, Number.NaN])(
      "refuses the rate limit %s",
      (rateLimitPerFiveMinutes) => {
        expect(() =>
          validateStages([withFrontdoor({ rateLimitPerFiveMinutes })]),
        ).toThrow(
          `platform-dev/sandbox: the rate limit ${String(rateLimitPerFiveMinutes)} must be a whole number from 10 to 2000000000`,
        );
      },
    );

    it.each([0, 31, 100])(
      "refuses the log retention %s",
      (logRetentionDays) => {
        expect(() =>
          validateStages([withFrontdoor({ logRetentionDays })]),
        ).toThrow(
          `platform-dev/sandbox: the log retention ${String(logRetentionDays)} must be one of the day counts CloudWatch Logs offers`,
        );
      },
    );

    it.each([1, 30, 90, 365])(
      "accepts the log retention %s",
      (logRetentionDays) => {
        expect(() =>
          validateStages([withFrontdoor({ logRetentionDays })]),
        ).not.toThrow();
      },
    );
  });

  describe("accounts", () => {
    it.each(["12345678901", "1234567890123", "12345678901a", " 100000000001"])(
      "refuses the account ID %j",
      (sharedAccount) => {
        expect(() => validateStages([{ ...STAGE, sharedAccount }])).toThrow(
          /platform-dev shared account: .* is not a 12-digit account ID/,
        );
      },
    );

    it("refuses a malformed frontdoor account ID", () => {
      expect(() =>
        validateStages([withEnvironment({ frontdoorAccount: "10000000002" })]),
      ).toThrow(
        'platform-dev/sandbox frontdoor account: "10000000002" is not a 12-digit account ID',
      );
    });

    it("refuses a malformed domain account ID", () => {
      const domainAccounts = [{ name: "main", account: "10000000003" }];
      expect(() =>
        validateStages([withEnvironment({ domainAccounts })]),
      ).toThrow(
        'platform-dev/sandbox main domain account: "10000000003" is not a 12-digit account ID',
      );
    });

    it("refuses an account used twice in a stage", () => {
      expect(() =>
        validateStages([withEnvironment({ frontdoorAccount: "100000000001" })]),
      ).toThrow(
        "platform-dev/sandbox frontdoor account: account 100000000001 is already the platform-dev shared account",
      );
    });

    it("refuses the same account as two domain accounts", () => {
      const domainAccounts = [
        { name: "main", account: "100000000003" },
        { name: "second", account: "100000000003" },
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
        frontdoorAccount: "100000000004",
        domainAccounts: [{ name: "main", account: "100000000003" }],
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
        sharedAccount: STAGE.environments[0]!.frontdoorAccount,
      };
      expect(() => validateStages([STAGE, other])).toThrow(
        "platform-prod shared account: account 100000000002 is already the platform-dev/sandbox frontdoor account",
      );
    });
  });
});
