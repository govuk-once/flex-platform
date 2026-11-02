import type { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackIn, ZONE } from "../test/helpers.ts";
import { WildcardCertificate } from "./wildcard-certificate.ts";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new WildcardCertificate(stack, "Zone", { zone: ZONE });
  return { app: stack.node.root as App, template: Template.fromStack(stack) };
}

describe("WildcardCertificate", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true).app.synth()).not.toThrow();
  });

  it("is one wildcard for the zone, validated in that zone, creating no zone", () => {
    const { template } = build();

    template.resourceCountIs("AWS::Route53::HostedZone", 0);
    template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: `*.${ZONE.zoneName}`,
      ValidationMethod: "DNS",
      DomainValidationOptions: [
        { DomainName: `*.${ZONE.zoneName}`, HostedZoneId: ZONE.hostedZoneId },
      ],
    });
  });

  it("waits for a CAA record at the apex allowing only Amazon", () => {
    const { template } = build();

    const records = template.findResources("AWS::Route53::RecordSet", {
      Properties: {
        Type: "CAA",
        Name: `${ZONE.zoneName}.`,
        ResourceRecords: ['0 issue "amazon.com"'],
      },
    });
    const [caa] = Object.keys(records);

    template.resourceCountIs("AWS::Route53::RecordSet", 1);
    template.hasResource("AWS::CertificateManager::Certificate", {
      DependsOn: [caa],
    });
  });
});
