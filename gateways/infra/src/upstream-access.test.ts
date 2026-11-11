import { describe, expect, it } from "vitest";

import { upstreamAccess } from "./upstream-access.ts";

const UPSTREAM_SECRET =
  "arn:aws:secretsmanager:eu-west-2:200000000001:secret:udp/flex/consumer-AbCdEf";
const UPSTREAM_KEY =
  "arn:aws:kms:eu-west-2:200000000001:key/00000000-0000-0000-0000-000000000000";
const UPSTREAM_ROLE = "arn:aws:iam::200000000001:role/udp-consumer";
const ENDPOINTS = ["vpce-0secretsmanager", "vpce-0sts"];

function statements(props: Parameters<typeof upstreamAccess>[0]) {
  return upstreamAccess(props).map((statement): unknown =>
    statement.toStatementJson(),
  );
}

describe("upstreamAccess", () => {
  it("reads an upstream's secret with its key, and assumes its roles, only through the endpoints", () => {
    expect(
      statements({
        secretArn: UPSTREAM_SECRET,
        secretKeyArn: UPSTREAM_KEY,
        roleArns: [UPSTREAM_ROLE],
        endpointIds: ENDPOINTS,
      }),
    ).toEqual([
      {
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: UPSTREAM_SECRET,
      },
      {
        Effect: "Deny",
        Action: ["secretsmanager:GetSecretValue", "sts:AssumeRole"],
        Resource: "*",
        Condition: { StringNotEquals: { "aws:SourceVpce": ENDPOINTS } },
      },
      {
        Effect: "Allow",
        Action: "kms:Decrypt",
        Resource: UPSTREAM_KEY,
        Condition: {
          StringEquals: {
            "kms:ViaService": "secretsmanager.eu-west-2.amazonaws.com",
          },
        },
      },
      { Effect: "Allow", Action: "sts:AssumeRole", Resource: UPSTREAM_ROLE },
    ]);
  });

  it("reads a secret of its own with no key, and assumes no role it isn't given", () => {
    const own =
      "arn:aws:secretsmanager:eu-west-2:123456789012:secret:gateway-sandbox-dvla-??????";
    expect(
      statements({
        secretArn: own,
        secretKeyArn: null,
        roleArns: [],
        endpointIds: ENDPOINTS,
      }),
    ).toEqual([
      {
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: own,
      },
      {
        Effect: "Deny",
        Action: ["secretsmanager:GetSecretValue", "sts:AssumeRole"],
        Resource: "*",
        Condition: { StringNotEquals: { "aws:SourceVpce": ENDPOINTS } },
      },
    ]);
  });
});
