import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUNDLE,
  COMMIT,
  CONFIG,
  fakeFetcher,
  functionUrlEvent,
  LAMBDA_REQUEST_ID,
  NOW,
  OTHER_KEY,
  OWNER_ID,
  REPOSITORY_ID,
  token,
  TRACE_ID,
} from "../../test/helpers.ts";
import { createAuthoriser, createUploadCheck } from "./authorise.ts";
import { createCiHandler } from "./handler.ts";
import { createUploadSigner } from "./sign-upload.ts";
import { createTokenVerifier } from "./token.ts";

interface LogLine {
  level: string;
  message: string;
  telemetry: { event: string; details: Record<string, unknown> };
}

const logged: LogLine[] = [];

// What was signed, so a test can see nothing was.
const signed: string[] = [];

const KEY = `example/bundle/${BUNDLE.sha256}.zip`;

const BUCKET_URL = `https://${CONFIG.uploads.bucket}.s3.eu-west-2.amazonaws.com`;

// Each reading of the clock is 7 ms after the one before, so a request that reads it twice took 7.
function handler(documents?: Record<string, unknown>) {
  const fake = fakeFetcher(documents);
  let now = NOW * 1000;
  const signUpload = createUploadSigner({
    uploads: CONFIG.uploads,
    credentials: () => ({
      accessKeyId: "SYNTHETIC_ACCESS_KEY_ID",
      secretAccessKey: "SYNTHETIC_SECRET_ACCESS_KEY",
      sessionToken: "SYNTHETIC_SESSION_TOKEN",
    }),
    now: () => NOW * 1000,
  });
  const handle = createCiHandler({
    verifyToken: createTokenVerifier(CONFIG, fake.fetcher),
    authorise: createAuthoriser(CONFIG),
    takesUploads: createUploadCheck(CONFIG),
    signUpload: (key, bundle) => {
      signed.push(key);
      return signUpload(key, bundle);
    },
    now: () => {
      const reading = now;
      now += 7;
      return reading;
    },
  });
  return { handle, fetched: fake.fetched };
}

const CALLER = {
  repositoryId: REPOSITORY_ID,
  ownerId: OWNER_ID,
  runId: "12345678901",
  commit: COMMIT,
};

// A staging job of the registered repository's, for the environment that takes no uploads.
const STAGING = {
  path: "/ci/environments/staging/domains/example/uploads",
  headers: {
    "x-flex-ci-token": token({ payload: { environment: "staging" } }),
  },
};

const REQUEST = {
  traceId: TRACE_ID,
  requestId: LAMBDA_REQUEST_ID,
  durationMs: 7,
};

function body(message: string, type: string): string {
  return JSON.stringify({ message, type });
}

describe("createCiHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW * 1000 });
    logged.length = 0;
    signed.length = 0;
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(JSON.parse(line) as LogLine);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers the registered repository's pipeline with where to upload its bundle", async () => {
    const { handle } = handler();

    const response = await handle(functionUrlEvent());

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-correlation-id": TRACE_ID,
    });
    const answer = JSON.parse(response.body) as Record<string, unknown>;
    expect(answer).toEqual({
      method: "PUT",
      url: expect.stringMatching(
        new RegExp(`^${BUCKET_URL}/${KEY}\\?.*X-Amz-Signature=[0-9a-f]{64}`),
      ) as unknown,
      headers: {
        "if-none-match": "*",
        "x-amz-checksum-sha256": Buffer.from(BUNDLE.sha256, "hex").toString(
          "base64",
        ),
      },
      expiresInSeconds: 300,
    });
    expect(logged).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event: "ci_upload_signed",
          details: {
            ...REQUEST,
            ...CALLER,
            environment: "development",
            domain: "example",
            key: KEY,
            size: BUNDLE.size,
          },
        },
      },
    ]);
  });

  // Whatever a pipeline says of its bundle, the key is under the domain it was allowed for.
  it("signs only a key under the path's domain, named by the bundle's hash", async () => {
    const { handle } = handler();

    await handle(functionUrlEvent());

    expect(signed).toEqual([KEY]);
  });

  it("answers 409 to an upload in an environment that takes its code by promotion", async () => {
    const { handle } = handler();

    await expect(handle(functionUrlEvent(STAGING))).resolves.toEqual({
      statusCode: 409,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": TRACE_ID,
        "x-rejected-by": "pipeline-api",
      },
      body: body("This environment takes no uploads", "client_error"),
    });
    expect(logged[0]?.telemetry).toEqual({
      event: "ci_upload_not_accepted",
      details: {
        ...REQUEST,
        ...CALLER,
        environment: "staging",
        domain: "example",
      },
    });
    expect(signed).toEqual([]);
  });

  it.each([
    ["body", { body: null }],
    ["body", { body: "not json" }],
    ["body", { body: JSON.stringify({ ...BUNDLE, key: "other/bundle.zip" }) }],
    ["sha256", { body: JSON.stringify({ ...BUNDLE, sha256: "abc" }) }],
    ["size", { body: JSON.stringify({ ...BUNDLE, size: 0 }) }],
  ])(
    "answers 400 to an allowed pipeline whose %s is no bundle's, signing nothing",
    async (reason, request) => {
      const { handle } = handler();

      await expect(handle(functionUrlEvent(request))).resolves.toMatchObject({
        statusCode: 400,
        body: body("Bad request", "client_error"),
      });
      expect(logged[0]?.telemetry).toEqual({
        event: "ci_upload_invalid",
        details: {
          ...REQUEST,
          ...CALLER,
          environment: "development",
          domain: "example",
          reason,
        },
      });
      expect(signed).toEqual([]);
    },
  );

  // The body is the caller's, so it is read only for a pipeline that is allowed.
  it("answers 403, not 400, to a pipeline that isn't allowed and sends no bundle", async () => {
    const { handle } = handler();

    await expect(
      handle(
        functionUrlEvent({
          path: "/ci/environments/development/domains/elsewhere/uploads",
          body: "not json",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(signed).toEqual([]);
  });

  it.each([[undefined], [""]])(
    "answers 401 to a request whose token is %j, without fetching any keys",
    async (value) => {
      const { handle, fetched } = handler();

      await expect(
        handle(functionUrlEvent({ headers: { "x-flex-ci-token": value } })),
      ).resolves.toMatchObject({
        statusCode: 401,
        body: body("Unauthorized", "auth_error"),
      });
      expect(logged).toEqual([
        expect.objectContaining({
          telemetry: { event: "ci_token_missing", details: REQUEST },
        }),
      ]);
      expect(fetched).toEqual([]);
    },
  );

  it("answers 401 to a token that fails verification, and logs why as a code", async () => {
    const { handle } = handler();

    await expect(
      handle(
        functionUrlEvent({
          headers: { "x-flex-ci-token": token({ key: OTHER_KEY }) },
        }),
      ),
    ).resolves.toMatchObject({
      statusCode: 401,
      body: body("Unauthorized", "auth_error"),
    });
    expect(logged).toEqual([
      expect.objectContaining({
        telemetry: {
          event: "ci_token_invalid",
          details: { ...REQUEST, reason: "signature" },
        },
      }),
    ]);
  });

  it("logs an expired token under its own event", async () => {
    const { handle } = handler();

    await expect(
      handle(
        functionUrlEvent({
          headers: {
            "x-flex-ci-token": token({ payload: { exp: NOW - 1 } }),
          },
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 401 });
    expect(logged[0]?.telemetry).toEqual({
      event: "ci_token_expired",
      details: { ...REQUEST, reason: "expired" },
    });
  });

  // A caller without a token learns nothing of the methods or the routes.
  it.each([
    ["another method", { method: "GET" }],
    ["an unknown path", { path: "/ci/unknown" }],
    [
      "a domain it couldn't release",
      { path: "/ci/environments/development/domains/elsewhere/uploads" },
    ],
  ])("answers 401 before looking at %s", async (_, request) => {
    const { handle } = handler();

    await expect(
      handle(
        functionUrlEvent({
          ...request,
          headers: { "x-flex-ci-token": undefined },
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 401 });
  });

  it.each(["GET", "PUT", "DELETE", "post"])(
    "answers 405 to a verified pipeline's %s",
    async (method) => {
      const { handle } = handler();

      await expect(handle(functionUrlEvent({ method }))).resolves.toMatchObject(
        {
          statusCode: 405,
          headers: expect.objectContaining({ allow: "POST" }) as unknown,
          body: body("Method not allowed", "client_error"),
        },
      );
      expect(logged[0]?.telemetry).toEqual({
        event: "ci_method_rejected",
        details: { ...REQUEST, ...CALLER },
      });
    },
  );

  it("answers 404 to a verified pipeline's request for a path that is no route", async () => {
    const { handle } = handler();

    await expect(
      handle(functionUrlEvent({ path: "/ci/environments/development" })),
    ).resolves.toMatchObject({
      statusCode: 404,
      body: body("Not found", "client_error"),
    });
    expect(logged[0]?.telemetry).toEqual({
      event: "ci_route_unknown",
      details: { ...REQUEST, ...CALLER },
    });
  });

  // One answer whatever the reason, so a pipeline learns nothing of which environments and
  // domains exist, or which repository a domain is registered to.
  it.each([
    [
      "environment-unknown",
      { path: "/ci/environments/production/domains/example/uploads" },
    ],
    [
      "domain-not-hosted",
      { path: "/ci/environments/development/domains/elsewhere/uploads" },
    ],
    [
      "domain-unregistered",
      { path: "/ci/environments/development/domains/unregistered/uploads" },
    ],
    [
      "repository",
      {
        headers: {
          "x-flex-ci-token": token({
            payload: { repository_id: "700000002" },
          }),
        },
      },
    ],
    [
      "owner",
      {
        headers: {
          "x-flex-ci-token": token({
            payload: { repository_owner_id: "90000002" },
          }),
        },
      },
    ],
    [
      "environment-claim",
      { path: "/ci/environments/staging/domains/example/uploads" },
    ],
    [
      "environment-claim",
      {
        headers: {
          "x-flex-ci-token": token({ payload: { environment: undefined } }),
        },
      },
    ],
  ])(
    "answers 403 to a pipeline refused as %s, with the reason only in the log",
    async (reason, request) => {
      const { handle } = handler();

      await expect(handle(functionUrlEvent(request))).resolves.toEqual({
        statusCode: 403,
        headers: {
          "content-type": "application/json",
          "x-correlation-id": TRACE_ID,
          "x-rejected-by": "pipeline-api",
        },
        body: body("Forbidden", "auth_error"),
      });
      expect(logged).toHaveLength(1);
      expect(logged[0]?.telemetry.event).toBe("ci_forbidden");
      expect(logged[0]?.telemetry.details).toMatchObject({
        ...REQUEST,
        reason,
      });
      // The path's names are the caller's own until the pipeline is allowed.
      expect(logged[0]?.telemetry.details).not.toHaveProperty("environment");
      expect(logged[0]?.telemetry.details).not.toHaveProperty("domain");
    },
  );

  it("answers 500 when the issuer's keys can't be fetched, logging only where it failed", async () => {
    const { handle } = handler({});

    await expect(handle(functionUrlEvent())).resolves.toMatchObject({
      statusCode: 500,
      body: body("Internal server error", "server_error"),
    });
    expect(logged).toEqual([
      {
        level: "ERROR",
        message: "telemetry",
        telemetry: {
          event: "ci_failed",
          details: { ...REQUEST, frames: expect.any(Array) as unknown },
        },
      },
    ]);
  });

  // A token in a log is a token anyone who reads the log can use until it expires. A repository's
  // name, its subject and its environment's name are text its admin chose.
  it("never logs the token or any text a repository's admin can write", async () => {
    const { handle } = handler();
    const sent = token({
      payload: {
        environment: "admin-chosen-text",
        run_id: "admin-chosen-text",
      },
    });

    await handle(functionUrlEvent());
    await handle(functionUrlEvent({ headers: { "x-flex-ci-token": sent } }));
    await handle(
      functionUrlEvent({
        path: "/ci/environments/caller-chosen-text/domains/example/uploads",
      }),
    );
    await handle(
      functionUrlEvent({
        headers: { "x-flex-ci-token": `${sent.slice(0, -4)}AAAA` },
      }),
    );

    const lines = JSON.stringify(logged);
    expect(logged).toHaveLength(4);
    // Nor the address an upload was signed for, or the credentials it was signed with.
    expect(lines).not.toContain("X-Amz-");
    expect(lines).not.toContain("SYNTHETIC");
    expect(lines).not.toContain("amazonaws.com");
    for (const segment of [...sent.split("."), ...token().split(".")]) {
      expect(lines).not.toContain(segment);
    }
    expect(lines).not.toContain("example-org");
    expect(lines).not.toContain("admin-chosen-text");
    expect(lines).not.toContain("caller-chosen-text");
  });

  it.each([
    [undefined],
    [""],
    ["not-a-trace-id"],
    ["1-6b49d200-97575440147627ab6e7b6276-extra"],
    ["1-6B49D200-97575440147627AB6E7B6276"],
  ])(
    "replaces the correlation ID %j with one made from Lambda's request ID",
    async (value) => {
      const { handle } = handler();
      const derived = traceIdFor(LAMBDA_REQUEST_ID, NOW);

      const response = await handle(
        functionUrlEvent({ headers: { "x-correlation-id": value } }),
      );

      expect(derived).toMatch(/^1-[0-9a-f]{8}-[0-9a-f]{24}$/);
      expect(response.headers["x-correlation-id"]).toBe(derived);
      expect(logged[0]?.telemetry.details.traceId).toBe(derived);
    },
  );
});
