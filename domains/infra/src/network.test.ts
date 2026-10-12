import { describe, expect, it } from "vitest";

import {
  ISOLATED_PLACEMENT,
  NETWORK,
  PRIVATE_PLACEMENT,
} from "../test/helpers.ts";
import type { DomainConfig } from "./config.ts";
import type { DomainNetwork } from "./network.ts";
import { placementFor, validateNetwork, vpcConfigFor } from "./network.ts";

const AT = "domain00 network";

const DOMAIN_CONFIG: DomainConfig = {
  name: "domain-one",
  routes: [{ method: "GET", path: "/a" }],
};

function validate(network: DomainNetwork): void {
  validateNetwork(network, { at: AT });
}

describe("validateNetwork", () => {
  it.each([
    ["both placements", NETWORK],
    ["an isolated placement alone", { isolated: ISOLATED_PLACEMENT }],
    ["no placements", {}],
  ])("accepts %s", (_, network) => {
    expect(() => validate(network)).not.toThrow();
  });

  it.each(["subnet-0123abcd", "subnet-0123456789abcdef0"])(
    "accepts the subnet ID %j",
    (subnetId) => {
      expect(() =>
        validate({
          isolated: { ...ISOLATED_PLACEMENT, subnetIds: [subnetId] },
        }),
      ).not.toThrow();
    },
  );

  it("refuses a placement with no subnets", () => {
    expect(() =>
      validate({ private: { ...PRIVATE_PLACEMENT, subnetIds: [] } }),
    ).toThrow(`${AT}: the private placement has no subnets`);
  });

  it.each([
    "subnet-0123",
    "subnet-0123456789ABCDEF0",
    "sg-0123456789abcdef0",
    "arn:aws:ec2:eu-west-2:100000000003:subnet/subnet-0123456789abcdef0",
    "",
  ])("refuses the subnet ID %j", (subnetId) => {
    expect(() =>
      validate({ isolated: { ...ISOLATED_PLACEMENT, subnetIds: [subnetId] } }),
    ).toThrow(`${AT}: ${JSON.stringify(subnetId)} is not a subnet ID`);
  });

  it.each(["sg-0123", "subnet-0123456789abcdef0", "sg-0123456789ABCDEF0"])(
    "refuses the security group ID %j",
    (securityGroupId) => {
      expect(() =>
        validate({ isolated: { ...ISOLATED_PLACEMENT, securityGroupId } }),
      ).toThrow(
        `${AT}: ${JSON.stringify(securityGroupId)} is not a security group ID`,
      );
    },
  );

  it("refuses a subnet in both placements, which would put a private function in isolated subnets", () => {
    const [shared] = ISOLATED_PLACEMENT.subnetIds;

    expect(() =>
      validate({
        isolated: ISOLATED_PLACEMENT,
        private: { ...PRIVATE_PLACEMENT, subnetIds: [shared!] },
      }),
    ).toThrow(
      `${AT}: ${shared} is in the isolated placement already, so the private placement can't have it`,
    );
  });

  it("refuses a subnet listed twice in one placement", () => {
    const [subnetId] = ISOLATED_PLACEMENT.subnetIds;

    expect(() =>
      validate({
        isolated: { ...ISOLATED_PLACEMENT, subnetIds: [subnetId!, subnetId!] },
      }),
    ).toThrow(
      `${AT}: ${subnetId} is in the isolated placement already, so the isolated placement can't have it`,
    );
  });
});

describe("placementFor", () => {
  it("places a domain with no access level in the isolated placement", () => {
    expect(placementFor(DOMAIN_CONFIG, NETWORK)).toBe(ISOLATED_PLACEMENT);
  });

  it.each([
    ["isolated", ISOLATED_PLACEMENT],
    ["private", PRIVATE_PLACEMENT],
  ] as const)("places a %s domain in that placement", (access, placement) => {
    expect(placementFor({ ...DOMAIN_CONFIG, access }, NETWORK)).toBe(placement);
  });

  it("places a public domain nowhere, whatever the network", () => {
    expect(
      placementFor({ ...DOMAIN_CONFIG, access: "public" }, {}),
    ).toBeUndefined();
  });

  it("refuses a level the network doesn't offer", () => {
    expect(() =>
      placementFor(
        { ...DOMAIN_CONFIG, access: "private" },
        { isolated: ISOLATED_PLACEMENT },
      ),
    ).toThrow(
      "The domain-one domain is private, and its domain account's network has no private placement",
    );
  });
});

describe("vpcConfigFor", () => {
  it("gives Lambda the subnets and the security group, and nothing else", () => {
    expect(vpcConfigFor(ISOLATED_PLACEMENT)).toEqual({
      subnetIds: ISOLATED_PLACEMENT.subnetIds,
      securityGroupIds: [ISOLATED_PLACEMENT.securityGroupId],
    });
  });
});
