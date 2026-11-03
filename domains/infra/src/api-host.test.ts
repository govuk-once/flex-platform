import type { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, EDGE_ROLE, stackIn, ZONE } from "../test/helpers.ts";
import { ApiHost } from "./api-host.ts";
import { ProxyApi } from "./proxy-api.ts";

const CERTIFICATE_ARN = `arn:aws:acm:eu-west-2:${ACCOUNT}:certificate/0a1b2c3d`;

// With the API it's built for, so the mapping has a real stage to name.
function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  const { api } = new ProxyApi(stack, "Domain", {
    environment: "sandbox",
    domain: "domain-a",
    edgeRole: EDGE_ROLE,
  });
  new ApiHost(stack, "Host", {
    domain: "domain-a",
    zone: ZONE,
    certificateArn: CERTIFICATE_ARN,
    api,
  });
  return { app: stack.node.root as App, template: Template.fromStack(stack) };
}

const HOST = `domain-a.${ZONE.zoneName}`;

describe("ApiHost", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true).app.synth()).not.toThrow();
  });

  it("answers at the domain's host with the certificate given, on TLS 1.3 or 1.2", () => {
    build().template.hasResourceProperties("AWS::ApiGateway::DomainName", {
      DomainName: HOST,
      EndpointConfiguration: { Types: ["REGIONAL"] },
      RegionalCertificateArn: CERTIFICATE_ARN,
      SecurityPolicy: "SecurityPolicy_TLS13_1_2_PFS_PQ_2025_09",
      EndpointAccessMode: "STRICT",
    });
  });

  it("maps the host's root to the API's stage", () => {
    build().template.hasResourceProperties("AWS::ApiGateway::BasePathMapping", {
      DomainName: { Ref: Match.stringLikeRegexp("^HostDomainName") },
      RestApiId: { Ref: Match.stringLikeRegexp("^DomainApi") },
      Stage: { Ref: Match.stringLikeRegexp("Stagedefault") },
      BasePath: Match.absent(),
    });
  });

  it("points the host at the custom domain in the account's zone, over IPv4 alone", () => {
    const { template } = build();

    template.resourceCountIs("AWS::Route53::RecordSet", 1);
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: `${HOST}.`,
      Type: "A",
      HostedZoneId: ZONE.hostedZoneId,
      AliasTarget: {
        DNSName: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("^HostDomainName"),
            "RegionalDomainName",
          ],
        },
      },
    });
  });
});
