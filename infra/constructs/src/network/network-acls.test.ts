import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { buildNetwork } from "../../test/network.ts";

type Entry = Record<string, unknown>;

// Each tier's entries, as CloudFormation sees them, by the tier's ACL.
function entries(tier: string): Entry[] {
  const { template } = buildNetwork();
  return Object.values(template.findResources("AWS::EC2::NetworkAclEntry"))
    .map(({ Properties }) => Properties as Entry)
    .filter(({ NetworkAclId }) =>
      (NetworkAclId as { Ref: string }).Ref.startsWith(`NetworkAcls${tier}`),
    )
    .map(({ NetworkAclId: _, ...entry }) => entry);
}

const WITHIN_VPC = [
  {
    RuleNumber: 100,
    Egress: false,
    CidrBlock: "10.0.0.0/16",
    Protocol: -1,
    RuleAction: "allow",
  },
  {
    RuleNumber: 100,
    Egress: true,
    CidrBlock: "10.0.0.0/16",
    Protocol: -1,
    RuleAction: "allow",
  },
];

// Refused from anywhere outside the VPC.
const REFUSED_IN = [
  {
    RuleNumber: 110,
    Egress: false,
    CidrBlock: "0.0.0.0/0",
    Protocol: 6,
    PortRange: { From: 0, To: 1023 },
    RuleAction: "deny",
  },
  {
    RuleNumber: 111,
    Egress: false,
    CidrBlock: "0.0.0.0/0",
    Protocol: 17,
    PortRange: { From: 0, To: 1023 },
    RuleAction: "deny",
  },
];

const HTTPS_OUT = [
  {
    RuleNumber: 200,
    Egress: true,
    CidrBlock: "0.0.0.0/0",
    Protocol: 6,
    PortRange: { From: 443, To: 443 },
    RuleAction: "allow",
  },
  {
    RuleNumber: 200,
    Egress: false,
    CidrBlock: "0.0.0.0/0",
    Protocol: 6,
    PortRange: { From: 1024, To: 65535 },
    RuleAction: "allow",
  },
];

describe("NetworkAcls", () => {
  it("lets an isolated subnet reach the VPC and nothing else", () => {
    const expected = [...WITHIN_VPC, ...REFUSED_IN];
    expect(entries("isolated")).toEqual(expect.arrayContaining(expected));
    expect(entries("isolated")).toHaveLength(expected.length);
  });

  it.each(["private", "public"])(
    "lets a %s subnet reach the VPC, and out on TCP 443",
    (tier) => {
      const expected = [...WITHIN_VPC, ...REFUSED_IN, ...HTTPS_OUT];
      expect(entries(tier)).toEqual(expect.arrayContaining(expected));
      expect(entries(tier)).toHaveLength(expected.length);
    },
  );

  // A network ACL applies the lowest-numbered rule that matches, so a deny numbered before the
  // replies' rule would drop any reply on a port it covers.
  it("refuses no reply port before the rule that lets replies in", () => {
    for (const tier of ["private", "public"]) {
      const inbound = entries(tier).filter(({ Egress }) => Egress === false);
      const replies = inbound.find(
        ({ RuleAction, PortRange }) =>
          RuleAction === "allow" &&
          (PortRange as { From: number } | undefined)?.From === 1024,
      );
      const refusingReplies = inbound.filter(
        ({ RuleAction, RuleNumber, PortRange }) =>
          RuleAction === "deny" &&
          (RuleNumber as number) < (replies?.RuleNumber as number) &&
          ((PortRange as { To: number } | undefined)?.To ?? 65535) >= 1024,
      );

      expect(replies).toBeDefined();
      expect(refusingReplies).toEqual([]);
    }
  });

  it("associates each tier's ACL with each of its subnets", () => {
    const { template } = buildNetwork();
    for (const tier of ["Public", "Private", "Isolated"]) {
      for (const zone of ["euwest2a", "euwest2b"]) {
        template.hasResourceProperties(
          "AWS::EC2::SubnetNetworkAclAssociation",
          {
            NetworkAclId: {
              Ref: Match.stringLikeRegexp(`^NetworkAcls${tier.toLowerCase()}`),
            },
            SubnetId: {
              Ref: Match.stringLikeRegexp(`^Network${tier}${zone}Subnet`),
            },
          },
        );
      }
    }
  });
});
