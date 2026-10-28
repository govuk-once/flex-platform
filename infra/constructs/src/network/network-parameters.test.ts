import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { buildNetwork } from "../../test/network.ts";

describe("NetworkParameters", () => {
  it("writes the IDs other stacks and the release pipeline read, under names from config", () => {
    const { template } = buildNetwork();

    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/flex/network/sandbox/vpc-id",
      Type: "String",
      Value: { Ref: Match.stringLikeRegexp("^NetworkVpc") },
    });
    for (const [placement, tier] of [
      ["isolated", "Isolated"],
      ["private", "Private"],
    ]) {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: `/flex/network/sandbox/${placement}-subnet-ids`,
        Type: "StringList",
        Value: {
          "Fn::Join": [
            ",",
            [
              { Ref: Match.stringLikeRegexp(`^Network${tier}euwest2aSubnet`) },
              { Ref: Match.stringLikeRegexp(`^Network${tier}euwest2bSubnet`) },
            ],
          ],
        },
      });
    }
    template.resourceCountIs("AWS::SSM::Parameter", 3);
  });
});

describe("the network", () => {
  it("has no unacknowledged cdk-nag finding, and passes the platform's checks", () => {
    expect(() => buildNetwork(undefined, true)).not.toThrow();
  });
});
