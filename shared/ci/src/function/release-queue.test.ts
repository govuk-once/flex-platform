import { NotFound, S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  parseReleaseMessage,
  type ReleaseRequest,
} from "@repo/shared-release/request";
import type { ReleaseTable } from "@repo/shared-release/table";
import { uuidV7 } from "@repo/utils/uuid-v7";
import { assert, describe, expect, it } from "vitest";

import { BUNDLE, COMMIT, CONFIG } from "../../test/helpers.ts";
import { createBundleFinder, createReleaseQueue } from "./release-queue.ts";

const KEY = `example/bundle/${BUNDLE.sha256}.zip`;

const VERSION_ID = "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY";

interface Sent {
  readonly command: string;
  readonly input: unknown;
}

// Any of the SDK's clients: each takes middleware at the start of a call.
interface Client {
  readonly middlewareStack: {
    add(middleware: unknown, options: unknown): void;
  };
}

// Answers each call the client sends in place of AWS, before anything is signed or sent, and
// records it. An answer that throws is AWS's error.
function answering(client: Client, answer: () => object): Sent[] {
  const sent: Sent[] = [];
  client.middlewareStack.add(
    (_next: unknown, context: { commandName: string }) =>
      (args: { input: unknown }) => {
        sent.push({ command: context.commandName, input: args.input });
        return Promise.resolve().then(() => ({
          output: { $metadata: {}, ...answer() },
          response: {},
        }));
      },
    { step: "initialize", priority: "high" },
  );
  return sent;
}

describe("createBundleFinder", () => {
  it("finds the version of the object under the key", async () => {
    const s3 = new S3Client({ region: "eu-west-2" });
    const sent = answering(s3, () => ({ VersionId: VERSION_ID }));

    await expect(createBundleFinder(CONFIG.uploads, s3)(KEY)).resolves.toBe(
      VERSION_ID,
    );
    expect(sent).toEqual([
      {
        command: "HeadObjectCommand",
        input: { Bucket: CONFIG.uploads.bucket, Key: KEY },
      },
    ]);
  });

  it("finds nothing where there is no object", async () => {
    const s3 = new S3Client({ region: "eu-west-2" });
    answering(s3, () => {
      throw new NotFound({ message: "SYNTHETIC", $metadata: {} });
    });

    await expect(
      createBundleFinder(CONFIG.uploads, s3)(KEY),
    ).resolves.toBeUndefined();
  });

  it("passes on anything else S3 answers, such as a refusal", async () => {
    const s3 = new S3Client({ region: "eu-west-2" });
    answering(s3, () => {
      throw new TypeError("SYNTHETIC");
    });

    await expect(createBundleFinder(CONFIG.uploads, s3)(KEY)).rejects.toThrow(
      TypeError,
    );
  });
});

describe("createReleaseQueue", () => {
  const request: ReleaseRequest = {
    environment: "development",
    domain: "example",
    sha256: BUNDLE.sha256,
    versionId: VERSION_ID,
    runId: "12345678901",
    commit: COMMIT,
  };
  const REQUESTED_AT = 1_800_000_000_000;
  const RANDOM = new Uint8Array(10).fill(7);
  const ID = uuidV7(REQUESTED_AT, RANDOM);
  const KEY = { environment: "development", domain: "example", id: ID };

  function queue(sqsAnswer: () => object = () => ({ MessageId: "1" })) {
    const calls: unknown[][] = [];
    const table: ReleaseTable = {
      create: (...args) => {
        calls.push(["create", ...args]);
        return Promise.resolve();
      },
      get: () => Promise.reject(new Error("unused")),
      claim: () => Promise.reject(new Error("unused")),
      finish: (...args) => {
        calls.push(["finish", ...args]);
        return Promise.resolve();
      },
    };
    const sqs = new SQSClient({ region: "eu-west-2" });
    const sent = answering(sqs, sqsAnswer);
    const queueRelease = createReleaseQueue({
      releases: CONFIG.releases,
      region: "eu-west-2",
      now: () => REQUESTED_AT,
      random: () => RANDOM,
      table,
      sqs,
    });
    return { queueRelease, calls, sent };
  }

  it("records the release, then sends its key in the domain's group, and answers its ID", async () => {
    const { queueRelease, calls, sent } = queue();

    await expect(queueRelease(request)).resolves.toBe(ID);

    expect(calls).toEqual([["create", ID, request, REQUESTED_AT]]);
    expect(sent).toEqual([
      {
        command: "SendMessageCommand",
        input: {
          QueueUrl: CONFIG.releases.queueUrl,
          MessageBody: expect.any(String) as unknown,
          MessageGroupId: "development.example",
          MessageDeduplicationId: ID,
        },
      },
    ]);
    const input = sent[0]?.input;
    assert(
      typeof input === "object" &&
        input !== null &&
        "MessageBody" in input &&
        typeof input.MessageBody === "string",
    );
    expect(parseReleaseMessage(input.MessageBody)).toEqual(KEY);
  });

  it("records a release it couldn't queue as refused, and passes on the queue's error", async () => {
    const { queueRelease, calls } = queue(() => {
      throw new TypeError("SYNTHETIC");
    });

    await expect(queueRelease(request)).rejects.toThrow(TypeError);
    expect(calls).toContainEqual([
      "finish",
      KEY,
      { status: "refused", step: "queue", reason: "not-queued" },
      REQUESTED_AT,
      "queued",
    ]);
  });

  it("records nothing the worker couldn't read back", async () => {
    const { queueRelease, calls, sent } = queue();

    await expect(
      queueRelease({ ...request, versionId: "a version" }),
    ).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  // AWS's own examples of a version ID hold "+" and "/".
  it("records a version ID in base64's characters", async () => {
    const { queueRelease, calls } = queue();
    const versionId =
      "3/L4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo";

    await queueRelease({ ...request, versionId });

    expect(calls).toEqual([
      ["create", ID, { ...request, versionId }, REQUESTED_AT],
    ]);
  });
});
