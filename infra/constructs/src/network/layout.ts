import { sortedNames } from "@repo/utils/sorted-names";

import type { Tier } from "./names.ts";

/** Domain accounts, and so their networks, are in eu-west-2, the region the edge signs for. */
export const NETWORK_REGION = "eu-west-2";

/**
 * The same in every account. Nothing peers with another network, so accounts may overlap; a
 * different range is a new VPC, and replaces everything in it.
 */
export const VPC_CIDR = "10.0.0.0/16";

interface ZoneLayout {
  readonly isolated: string;
  readonly private: string;
  readonly public: string;
  /** Reserved for AWS Network Firewall's endpoints. Nothing is created in it yet. */
  readonly firewall: string;
}

/**
 * Each availability zone's subnets, by zone name, so adding or removing a zone never moves
 * another's: a subnet whose range changes is replaced, and so is everything in it. eu-west-2 has
 * three zones, and each has its place whether or not config uses it.
 *
 *   10.0.0.0/18     isolated, a /20 per zone, one spare
 *   10.0.64.0/18    private, a /20 per zone, one spare
 *   10.0.128.0/22   public, a /24 per zone, NAT gateways only
 *   10.0.132.0/24   firewall, a /28 per zone, reserved
 */
export const ZONE_LAYOUT: Readonly<Record<string, ZoneLayout>> = {
  "eu-west-2a": {
    isolated: "10.0.0.0/20",
    private: "10.0.64.0/20",
    public: "10.0.128.0/24",
    firewall: "10.0.132.0/28",
  },
  "eu-west-2b": {
    isolated: "10.0.16.0/20",
    private: "10.0.80.0/20",
    public: "10.0.129.0/24",
    firewall: "10.0.132.16/28",
  },
  "eu-west-2c": {
    isolated: "10.0.32.0/20",
    private: "10.0.96.0/20",
    public: "10.0.130.0/24",
    firewall: "10.0.132.32/28",
  },
};

/** The availability zones config may list. */
export const AVAILABILITY_ZONES: readonly string[] = sortedNames(
  Object.keys(ZONE_LAYOUT),
);

/** Lambda runs a function in several zones so one zone failing doesn't stop it. */
export const MINIMUM_AVAILABILITY_ZONES = 2;

/**
 * The zones, sorted, so the order config lists them in changes nothing. Throws on a zone with no
 * layout, a repeat, or too few.
 */
export function networkZones(zones: readonly string[]): readonly string[] {
  for (const zone of zones) {
    if (!Object.hasOwn(ZONE_LAYOUT, zone)) {
      throw new Error(
        `${JSON.stringify(zone)} is not an availability zone the network has a layout for: ${AVAILABILITY_ZONES.join(", ")}`,
      );
    }
  }
  if (new Set(zones).size !== zones.length) {
    throw new Error(
      `An availability zone is listed twice: ${zones.join(", ")}`,
    );
  }
  if (zones.length < MINIMUM_AVAILABILITY_ZONES) {
    throw new Error(
      `A network needs at least ${MINIMUM_AVAILABILITY_ZONES} availability zones, not ${zones.length}`,
    );
  }
  return sortedNames(zones);
}

export function subnetCidr(zone: string, tier: Tier): string {
  const layout = Object.hasOwn(ZONE_LAYOUT, zone)
    ? ZONE_LAYOUT[zone]
    : undefined;
  if (layout === undefined) {
    throw new Error(`No layout for the availability zone ${zone}`);
  }
  return layout[tier];
}
