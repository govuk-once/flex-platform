import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_ZONES,
  networkZones,
  subnetCidr,
  VPC_CIDR,
  ZONE_LAYOUT,
} from "./layout.ts";

function range(cidr: string): [number, number] {
  const [address = "", bits = ""] = cidr.split("/");
  const start = address
    .split(".")
    .reduce((total, octet) => total * 256 + Number(octet), 0);
  return [start, start + 2 ** (32 - Number(bits)) - 1];
}

describe("ZONE_LAYOUT", () => {
  const blocks = Object.entries(ZONE_LAYOUT).flatMap(([zone, layout]) =>
    Object.entries<string>({ ...layout }).map(([tier, cidr]) => ({
      at: `${zone} ${tier}`,
      cidr,
    })),
  );

  it("lays out each of eu-west-2's zones", () => {
    expect(AVAILABILITY_ZONES).toEqual([
      "eu-west-2a",
      "eu-west-2b",
      "eu-west-2c",
    ]);
  });

  it("keeps every block inside the VPC's range", () => {
    const [vpcStart, vpcEnd] = range(VPC_CIDR);
    for (const { cidr } of blocks) {
      const [start, end] = range(cidr);
      expect(start).toBeGreaterThanOrEqual(vpcStart);
      expect(end).toBeLessThanOrEqual(vpcEnd);
    }
  });

  // Firewall blocks included: they are reserved, so nothing else may take them.
  it("gives no two blocks an address in common", () => {
    for (const [index, first] of blocks.entries()) {
      for (const second of blocks.slice(index + 1)) {
        const [firstStart, firstEnd] = range(first.cidr);
        const [secondStart, secondEnd] = range(second.cidr);
        expect(
          firstEnd < secondStart || secondEnd < firstStart,
          `${first.at} and ${second.at} overlap`,
        ).toBe(true);
      }
    }
  });

  it("starts each block on its own boundary", () => {
    for (const { cidr } of blocks) {
      const [start, end] = range(cidr);
      expect(start % (end - start + 1)).toBe(0);
    }
  });
});

describe("networkZones", () => {
  it("sorts the zones, so the order config lists them in changes nothing", () => {
    expect(networkZones(["eu-west-2c", "eu-west-2a"])).toEqual([
      "eu-west-2a",
      "eu-west-2c",
    ]);
  });

  it("refuses a zone with no layout", () => {
    expect(() => networkZones(["eu-west-2a", "eu-west-1a"])).toThrow(
      '"eu-west-1a" is not an availability zone the network has a layout for',
    );
  });

  it("refuses a zone listed twice", () => {
    expect(() =>
      networkZones(["eu-west-2a", "eu-west-2b", "eu-west-2a"]),
    ).toThrow("An availability zone is listed twice");
  });

  it("refuses fewer than two zones", () => {
    expect(() => networkZones(["eu-west-2a"])).toThrow(
      "A network needs at least 2 availability zones, not 1",
    );
  });

  // An inherited name, such as `constructor`, is not a zone.
  it("reads only the layout's own zones", () => {
    expect(() => networkZones(["constructor", "eu-west-2a"])).toThrow(
      "is not an availability zone",
    );
    expect(() => subnetCidr("constructor", "public")).toThrow(
      "No layout for the availability zone constructor",
    );
  });
});
