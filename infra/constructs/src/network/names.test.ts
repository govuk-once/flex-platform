import { describe, expect, it } from "vitest";

import {
  natGatewayAlarmName,
  restrictDefaultSecurityGroupLogGroupName,
  securityGroupIdParameterName,
  subnetIdsParameterName,
  subnetName,
  vpcIdParameterName,
  vpcName,
} from "./names.ts";

describe("network names", () => {
  it("follows the template", () => {
    expect(vpcName("dev")).toBe("network-dev");
    expect(subnetName("dev", "isolated", "eu-west-2a")).toBe(
      "network-dev-isolated-eu-west-2a",
    );
    expect(vpcIdParameterName("dev")).toBe("/flex/network/dev/vpc-id");
    expect(subnetIdsParameterName("dev", "private")).toBe(
      "/flex/network/dev/private-subnet-ids",
    );
    expect(securityGroupIdParameterName("dev", "domain")).toBe(
      "/flex/network/dev/security-group/domain",
    );
    expect(restrictDefaultSecurityGroupLogGroupName("dev")).toBe(
      "/flex/network/dev/restrict-default-security-group",
    );
    expect(natGatewayAlarmName("dev", "eu-west-2a", "port-allocation")).toBe(
      "network-dev-nat-eu-west-2a-port-allocation",
    );
  });
});
