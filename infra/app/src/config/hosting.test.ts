import { describe, expect, it } from "vitest";

import { DOMAIN_ONE, DOMAIN_TWO, FIXTURE_STAGES } from "../../test/helpers.ts";
import {
  domainAccountFor,
  domainRoutesFor,
  domainsFor,
  hostNameFor,
} from "./hosting.ts";

const [, , PROD] = FIXTURE_STAGES;
const [DEV, , PROD_ENVIRONMENT] = PROD.environments;
const [MAIN, SECOND] = PROD_ENVIRONMENT.domainAccounts;

describe("hosting", () => {
  it("finds the domains an account hosts in an environment", () => {
    expect(domainsFor(MAIN, { environment: PROD_ENVIRONMENT })).toEqual([
      DOMAIN_ONE,
    ]);
    expect(domainsFor(SECOND, { environment: PROD_ENVIRONMENT })).toEqual([
      DOMAIN_TWO,
    ]);
  });

  it("finds the account that hosts a domain in an environment", () => {
    expect(
      domainAccountFor(DOMAIN_TWO, { environment: PROD_ENVIRONMENT }),
    ).toBe(SECOND);
  });

  it("refuses a domain whose account the environment doesn't have", () => {
    expect(() => domainAccountFor(DOMAIN_TWO, { environment: DEV })).toThrow(
      "dev: the domain-two domain's domain account, second, isn't in the environment",
    );
  });

  it("puts a domain's host under its account's zone in that environment", () => {
    const [devMain] = DEV.domainAccounts;

    expect(hostNameFor(DOMAIN_ONE, { environment: DEV })).toBe(
      `domain-one.${devMain.zone.name}`,
    );
    expect(hostNameFor(DOMAIN_ONE, { environment: PROD_ENVIRONMENT })).toBe(
      `domain-one.${MAIN.zone.name}`,
    );
  });

  it("routes each domain the environment hosts to its host, and no other", () => {
    expect(domainRoutesFor(PROD_ENVIRONMENT)).toEqual({
      "domain-one": `domain-one.${MAIN.zone.name}`,
      "domain-two": `domain-two.${SECOND.zone.name}`,
    });
    expect(domainRoutesFor(DEV)).toEqual({
      "domain-one": `domain-one.${DEV.domainAccounts[0].zone.name}`,
    });
  });
});
