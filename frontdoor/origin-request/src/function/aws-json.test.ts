import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { AwsCallFailed, createAwsJsonCall } from "./aws-json.ts";

const CREDENTIALS = {
  accessKeyId: "SYNTHETIC_ACCESS_KEY",
  secretAccessKey: "SYNTHETIC_SECRET",
  sessionToken: "SYNTHETIC_TOKEN",
};

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function standIn(status: number, body: string) {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString()));
    request.on("end", () => {
      received.push({ headers: request.headers, body: text });
      response.statusCode = status;
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  const { port } = server.address() as AddressInfo;
  return { received, endpoint: () => `http://127.0.0.1:${String(port)}` };
}

describe("createAwsJsonCall", () => {
  it("posts the body to the target, signed for the service and region", async () => {
    const aws = await standIn(200, '{"Parameter":{"Value":"x"}}');
    const call = createAwsJsonCall(() => CREDENTIALS, aws.endpoint);

    await expect(
      call({
        service: "ssm",
        region: "eu-west-2",
        target: "AmazonSSM.GetParameter",
        body: { Name: "/flex/example" },
      }),
    ).resolves.toEqual({ Parameter: { Value: "x" } });

    const [request] = aws.received;
    expect(request?.body).toBe('{"Name":"/flex/example"}');
    expect(request?.headers["x-amz-target"]).toBe("AmazonSSM.GetParameter");
    expect(request?.headers["x-amz-security-token"]).toBe("SYNTHETIC_TOKEN");
    expect(request?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=SYNTHETIC_ACCESS_KEY\/\d{8}\/eu-west-2\/ssm\/aws4_request, /,
    );
  });

  it("fails with AWS's error code alone, never its message", async () => {
    const aws = await standIn(
      400,
      '{"__type":"com.amazonaws.kms#AccessDeniedException","message":"SYNTHETIC detail"}',
    );
    const call = createAwsJsonCall(() => CREDENTIALS, aws.endpoint);
    const failure = call({
      service: "kms",
      region: "us-east-1",
      target: "TrentService.Decrypt",
      body: {},
    });

    await expect(failure).rejects.toBeInstanceOf(AwsCallFailed);
    await expect(failure).rejects.toThrow(
      "An AWS call failed: AccessDeniedException",
    );
  });

  it("names an error it can't read as unknown", async () => {
    const aws = await standIn(500, "<html>SYNTHETIC</html>");
    const call = createAwsJsonCall(() => CREDENTIALS, aws.endpoint);
    await expect(
      call({ service: "ssm", region: "us-east-1", target: "X", body: {} }),
    ).rejects.toThrow("An AWS call failed: Unknown");
  });
});
