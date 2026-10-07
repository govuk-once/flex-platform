import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/create-app.ts";

function synthesise(stage: string) {
  const app = createApp({ STAGE: stage, CDK_DEFAULT_ACCOUNT: "123456789012" });
  const assembly = app.synth();
  const edge = assembly.getStackByName(`${stage}-FlexEdge`);
  const global = assembly.getStackByName(`${stage}-FlexEdgeGlobal`);
  return {
    assembly,
    edge,
    global,
    edgeTemplate: Template.fromJSON(edge.template as object),
    globalTemplate: Template.fromJSON(global.template as object),
  };
}

type Resources = Record<string, { Type: string; Properties: unknown }>;

describe("createApp", () => {
  it("needs the account, which cross region references are resolved by", () => {
    expect(() => createApp({ STAGE: "development" })).toThrow(
      "CDK_DEFAULT_ACCOUNT",
    );
  });

  it("puts the edge in eu-west-2 and only what CloudFront requires in us-east-1", () => {
    const { assembly, edge, global, edgeTemplate, globalTemplate } =
      synthesise("development");

    expect(assembly.stacks.map((stack) => stack.stackName).sort()).toEqual([
      "development-FlexEdge",
      "development-FlexEdgeGlobal",
    ]);
    expect(edge.environment).toMatchObject({
      region: "eu-west-2",
      account: "123456789012",
    });
    expect(global.environment).toMatchObject({
      region: "us-east-1",
      account: "123456789012",
    });

    const types = (template: Template) =>
      new Set(
        Object.values(template.toJSON().Resources as Resources).map(
          (r) => r.Type,
        ),
      );
    const globalTypes = types(globalTemplate);
    expect(globalTypes).toContain("AWS::WAFv2::WebACL");
    expect(globalTypes).toContain("AWS::WAFv2::LoggingConfiguration");
    expect(globalTypes).toContain("AWS::Logs::LogGroup");
    expect(globalTypes).toContain("AWS::CertificateManager::Certificate");
    expect(globalTypes).not.toContain("AWS::CloudFront::Distribution");
    expect(globalTypes).not.toContain("AWS::S3::Bucket");

    const edgeTypes = types(edgeTemplate);
    expect(edgeTypes).toContain("AWS::CloudFront::Distribution");
    expect(edgeTypes).toContain("AWS::S3::Bucket");
    expect(edgeTypes).toContain("AWS::Route53::RecordSet");
    expect(edgeTypes).toContain("AWS::SSM::Parameter");
    expect(edgeTypes).not.toContain("AWS::WAFv2::WebACL");
    expect(edgeTypes).not.toContain("AWS::CertificateManager::Certificate");

    expect(edge.dependencies.map((d) => d.id)).toContain(
      "development-FlexEdgeGlobal",
    );
  });

  it("keeps an environment's logs and protects its stacks from deletion", () => {
    const { edge, global, edgeTemplate, globalTemplate } =
      synthesise("staging");

    expect(edge.terminationProtection).toBe(true);
    expect(global.terminationProtection).toBe(true);
    edgeTemplate.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: { ObjectLockEnabled: true },
    });
    globalTemplate.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
    });
  });

  it("removes an ephemeral stage's logs with its stacks", () => {
    const { edge, global, edgeTemplate, globalTemplate } = synthesise("pr-123");

    expect(edge.terminationProtection).toBe(false);
    expect(global.terminationProtection).toBe(false);
    edgeTemplate.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
    edgeTemplate.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
    globalTemplate.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Delete",
    });
  });

  it("tags every resource with the platform's tags and the stage", () => {
    const { edgeTemplate } = synthesise("development");

    edgeTemplate.hasResourceProperties("AWS::S3::Bucket", {
      Tags: [
        { Key: "Environment", Value: "development" },
        { Key: "Owner", Value: "N/A" },
        { Key: "Product", Value: "GOV.UK" },
        { Key: "ResourceOwner", Value: "flex-platform" },
        {
          Key: "Source",
          Value: "https://github.com/govuk-once/flex-platform",
        },
        { Key: "Stage", Value: "development" },
        { Key: "System", Value: "FLEX" },
      ],
    });
  });

  it("reads its surroundings from parameters in eu-west-2 and writes the edge back there", () => {
    const { edgeTemplate, globalTemplate } = synthesise("pr-123");

    const read = Object.values(
      edgeTemplate.toJSON().Parameters as Record<string, { Default?: string }>,
    ).map((p) => p.Default);
    expect(read).toEqual(
      expect.arrayContaining([
        "/infra/dns/hostedzoneid",
        "/infra/dns/hostedzonename",
        "/pr-123/flex/edge/origin/domain-name",
      ]),
    );

    const reads = Object.values(
      globalTemplate.toJSON().Resources as Resources,
    ).filter((r) => r.Type === "Custom::AWS");
    expect(reads).toHaveLength(2);
    expect(JSON.stringify(reads)).toContain('\\"region\\":\\"eu-west-2\\"');

    edgeTemplate.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/pr-123/flex/edge/distribution-id",
    });
    edgeTemplate.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/pr-123/flex/edge/url",
    });
    edgeTemplate.hasOutput("EdgeUrl", {});
    edgeTemplate.hasOutput("WafLogGroupName", {
      Value: "aws-waf-logs-pr-123-flex-edge",
    });
    edgeTemplate.hasOutput("AccessLogBucketName", {});
    globalTemplate.hasOutput("WebAclArn", {});
    globalTemplate.hasOutput("CertificateArn", {});
  });

  it("names an ephemeral stage under the zone and an environment at its apex", () => {
    const certificateOf = (stage: string) =>
      Object.values(
        synthesise(stage).globalTemplate.toJSON().Resources as Resources,
      ).find((r) => r.Type === "AWS::CertificateManager::Certificate");

    expect(JSON.stringify(certificateOf("pr-123")?.Properties)).toContain(
      "pr-123.",
    );
    expect(
      JSON.stringify(certificateOf("production")?.Properties),
    ).not.toContain("production.");
  });
});
