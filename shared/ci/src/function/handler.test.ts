import { traceIdFor } from "@repo/cloudfront-js-utils/trace-id-for";
import type { ReleaseRecord, ReleaseRequest } from "@repo/shared-release";
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
  UPLOAD,
  VERSION,
} from "../../test/helpers.ts";
import type { Artefact } from "./artefacts.ts";
import { createAuthoriser, createPublishCheck } from "./authorise.ts";
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

// What was asked of the release worker.
const queued: ReleaseRequest[] = [];

// The bucket's objects, by key, and the version each holds.
const objects = new Map<string, string>();

// Each version recorded, by its domain and version.
const artefacts = new Map<string, Artefact>();

// Each release recorded, by its environment, domain and ID.
const releases = new Map<string, ReleaseRecord>();

const VERSION_ID = "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY";

const RELEASES = "/ci/environments/development/domains/example/releases";

const RELEASE_ID = "0196a8f0-2c00-7000-8000-000000000000";

const RELEASE_BODY = JSON.stringify({ version: VERSION });

// A release the table holds, as it was asked for, and once it went live.
const ASKED: ReleaseRecord = {
  id: RELEASE_ID,
  environment: "development",
  domain: "example",
  version: VERSION,
  sha256: BUNDLE.sha256,
  versionId: VERSION_ID,
  runId: "12345678901",
  commit: COMMIT,
  status: "queued",
  requestedAt: Date.parse("2027-01-15T08:00:00.000Z"),
  updatedAt: Date.parse("2027-01-15T08:01:30.000Z"),
  attempts: 1,
};

const RECORD: ReleaseRecord = {
  ...ASKED,
  status: "released",
  functionVersion: "3",
  created: false,
  moved: true,
};

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
    publishes: createPublishCheck(CONFIG),
    claimVersion: (artefact) => {
      const key = `${artefact.domain}/${artefact.version}`;
      const held = artefacts.get(key);
      if (held !== undefined) return Promise.resolve(held.sha256);
      artefacts.set(key, artefact);
      return Promise.resolve(artefact.sha256);
    },
    signUpload: (key, bundle) => {
      signed.push(key);
      return signUpload(key, bundle);
    },
    findArtefact: (domain, version) =>
      Promise.resolve(artefacts.get(`${domain}/${version}`)?.sha256),
    findBundle: (key) => Promise.resolve(objects.get(key)),
    queueRelease: (request) => {
      queued.push(request);
      return Promise.resolve(RELEASE_ID);
    },
    findRelease: (key) =>
      Promise.resolve(
        releases.get(`${key.environment}/${key.domain}/${key.id}`),
      ),
    now: () => {
      const reading = now;
      now += 7;
      return reading;
    },
  });
  return { handle, fetched: fake.fetched };
}

// The version in these tests, recorded for the bundle, which is in the bucket.
function uploaded(): void {
  artefacts.set(`example/${VERSION}`, {
    domain: "example",
    version: VERSION,
    sha256: BUNDLE.sha256,
  });
  objects.set(KEY, VERSION_ID);
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
    queued.length = 0;
    objects.clear();
    artefacts.clear();
    releases.clear();
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
      uploaded: false,
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
            version: VERSION,
            key: KEY,
            size: BUNDLE.size,
          },
        },
      },
    ]);
  });

  // The domain's, not the environment's: the same bundle goes to each environment in turn.
  it("records the version as the domain's bundle, with the run that uploaded it", async () => {
    const { handle } = handler();

    await handle(functionUrlEvent());

    expect([...artefacts.values()]).toEqual([
      {
        domain: "example",
        version: VERSION,
        sha256: BUNDLE.sha256,
        runId: CALLER.runId,
        commit: COMMIT,
      },
    ]);
  });

  // A run that stopped before its upload, run again.
  it("signs the upload again for a version recorded with the same bundle, which isn't there yet", async () => {
    const { handle } = handler();
    await handle(functionUrlEvent());

    await expect(handle(functionUrlEvent())).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(signed).toEqual([KEY, KEY]);
  });

  it("answers that there is nothing to upload when the bundle is there already, signing nothing", async () => {
    const { handle } = handler();
    objects.set(KEY, VERSION_ID);

    await expect(handle(functionUrlEvent())).resolves.toEqual({
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": TRACE_ID,
      },
      body: JSON.stringify({
        version: VERSION,
        sha256: BUNDLE.sha256,
        uploaded: true,
      }),
    });
    expect(logged[0]?.telemetry).toEqual({
      event: "ci_upload_present",
      details: {
        ...REQUEST,
        ...CALLER,
        environment: "development",
        domain: "example",
        version: VERSION,
        key: KEY,
        size: BUNDLE.size,
      },
    });
    expect(signed).toEqual([]);
  });

  // Two versions with the same bytes share one object.
  it("answers that there is nothing to upload for a new version of a bundle that is there", async () => {
    const { handle } = handler();
    objects.set(KEY, VERSION_ID);
    await handle(functionUrlEvent());

    await expect(
      handle(
        functionUrlEvent({
          body: JSON.stringify({ ...UPLOAD, version: "1.4.3" }),
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(artefacts.size).toBe(2);
    expect(signed).toEqual([]);
  });

  it("answers 409 to a version recorded with another bundle, signing nothing and keeping the record", async () => {
    const { handle } = handler();
    await handle(functionUrlEvent());
    signed.length = 0;
    logged.length = 0;
    const other = "0".repeat(64);

    await expect(
      handle(
        functionUrlEvent({
          body: JSON.stringify({ ...UPLOAD, sha256: other }),
        }),
      ),
    ).resolves.toEqual({
      statusCode: 409,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": TRACE_ID,
        "x-rejected-by": "pipeline-api",
      },
      body: body("This version is already a different bundle", "client_error"),
    });
    expect(logged[0]?.telemetry).toEqual({
      event: "ci_upload_version_taken",
      details: {
        ...REQUEST,
        ...CALLER,
        environment: "development",
        domain: "example",
        version: VERSION,
        key: `example/bundle/${other}.zip`,
        size: BUNDLE.size,
      },
    });
    expect(signed).toEqual([]);
    expect(artefacts.get(`example/${VERSION}`)?.sha256).toBe(BUNDLE.sha256);
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
    expect(artefacts.size).toBe(0);
  });

  it.each([
    ["body", { body: null }],
    ["body", { body: "not json" }],
    ["body", { body: JSON.stringify({ ...UPLOAD, key: "other/bundle.zip" }) }],
    ["version", { body: JSON.stringify(BUNDLE) }],
    ["version", { body: JSON.stringify({ ...UPLOAD, version: "v1.4.2" }) }],
    ["sha256", { body: JSON.stringify({ ...UPLOAD, sha256: "abc" }) }],
    ["size", { body: JSON.stringify({ ...UPLOAD, size: 0 }) }],
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
      expect(artefacts.size).toBe(0);
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

  it("queues the release of a version the pipeline uploaded, and answers 202", async () => {
    const { handle } = handler();
    uploaded();

    const response = await handle(
      functionUrlEvent({ path: RELEASES, body: RELEASE_BODY }),
    );

    expect(response).toEqual({
      statusCode: 202,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": TRACE_ID,
      },
      body: JSON.stringify({
        releaseId: RELEASE_ID,
        environment: "development",
        domain: "example",
        version: VERSION,
        sha256: BUNDLE.sha256,
      }),
    });
    expect(queued).toEqual([
      {
        environment: "development",
        domain: "example",
        version: VERSION,
        sha256: BUNDLE.sha256,
        versionId: VERSION_ID,
        runId: "12345678901",
        commit: COMMIT,
      },
    ]);
    expect(logged).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event: "ci_release_queued",
          details: {
            ...REQUEST,
            ...CALLER,
            environment: "development",
            domain: "example",
            version: VERSION,
            key: KEY,
            versionId: VERSION_ID,
            releaseId: RELEASE_ID,
          },
        },
      },
    ]);
  });

  it("answers 409 to a release of a version that was never uploaded, queueing nothing", async () => {
    const { handle } = handler();
    objects.set(KEY, VERSION_ID);

    await expect(
      handle(functionUrlEvent({ path: RELEASES, body: RELEASE_BODY })),
    ).resolves.toMatchObject({
      statusCode: 409,
      body: body(
        "No bundle with this version has been uploaded",
        "client_error",
      ),
    });
    expect(logged[0]?.telemetry).toEqual({
      event: "ci_release_version_unknown",
      details: {
        ...REQUEST,
        ...CALLER,
        environment: "development",
        domain: "example",
        version: VERSION,
      },
    });
    expect(queued).toEqual([]);
  });

  // A version is claimed before its bundle is uploaded, by a run that may have stopped.
  it("answers 409 to a release of a version whose bundle never arrived, queueing nothing", async () => {
    const { handle } = handler();
    await handle(functionUrlEvent());
    logged.length = 0;

    await expect(
      handle(functionUrlEvent({ path: RELEASES, body: RELEASE_BODY })),
    ).resolves.toMatchObject({
      statusCode: 409,
      body: body(
        "No bundle with this version has been uploaded",
        "client_error",
      ),
    });
    expect(logged[0]?.telemetry).toEqual({
      event: "ci_release_bundle_missing",
      details: {
        ...REQUEST,
        ...CALLER,
        environment: "development",
        domain: "example",
        version: VERSION,
        key: KEY,
      },
    });
    expect(queued).toEqual([]);
  });

  // Another domain's versions are its own, which this route never looks at.
  it("looks for the version only under the domain the pipeline is allowed for", async () => {
    const { handle } = handler();
    artefacts.set(`elsewhere/${VERSION}`, {
      domain: "elsewhere",
      version: VERSION,
      sha256: BUNDLE.sha256,
    });
    objects.set(`elsewhere/bundle/${BUNDLE.sha256}.zip`, VERSION_ID);

    await expect(
      handle(functionUrlEvent({ path: RELEASES, body: RELEASE_BODY })),
    ).resolves.toMatchObject({ statusCode: 409 });
    expect(queued).toEqual([]);
  });

  it("answers 409 to a release in an environment that takes its code by promotion", async () => {
    const { handle } = handler();
    uploaded();

    await expect(
      handle(
        functionUrlEvent({
          ...STAGING,
          path: "/ci/environments/staging/domains/example/releases",
          body: RELEASE_BODY,
        }),
      ),
    ).resolves.toMatchObject({
      statusCode: 409,
      body: body("This environment takes no releases", "client_error"),
    });
    expect(logged[0]?.telemetry.event).toBe("ci_release_not_accepted");
    expect(queued).toEqual([]);
  });

  it.each([
    ["body", UPLOAD],
    // A release names its bundle by version alone.
    ["body", { sha256: BUNDLE.sha256 }],
    ["version", { version: "1.4" }],
  ])(
    "answers 400 to a release whose %s is no release's, queueing nothing",
    async (reason, sent) => {
      const { handle } = handler();
      uploaded();

      await expect(
        handle(
          functionUrlEvent({ path: RELEASES, body: JSON.stringify(sent) }),
        ),
      ).resolves.toMatchObject({ statusCode: 400 });
      expect(logged[0]?.telemetry).toEqual({
        event: "ci_release_invalid",
        details: {
          ...REQUEST,
          ...CALLER,
          environment: "development",
          domain: "example",
          reason,
        },
      });
      expect(queued).toEqual([]);
    },
  );

  it("answers how a release went, as the table has it, never to be kept", async () => {
    const { handle } = handler();
    releases.set(`development/example/${RELEASE_ID}`, RECORD);

    const response = await handle(
      functionUrlEvent({
        method: "GET",
        path: `${RELEASES}/${RELEASE_ID}`,
        body: null,
      }),
    );

    expect(response).toEqual({
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-correlation-id": TRACE_ID,
      },
      body: JSON.stringify({
        releaseId: RELEASE_ID,
        environment: "development",
        domain: "example",
        version: VERSION,
        sha256: BUNDLE.sha256,
        status: "released",
        requestedAt: "2027-01-15T08:00:00.000Z",
        updatedAt: "2027-01-15T08:01:30.000Z",
        attempts: 1,
        functionVersion: "3",
        created: false,
        moved: true,
        runId: "12345678901",
        commit: COMMIT,
      }),
    });
    expect(logged).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event: "ci_release_status",
          details: {
            ...REQUEST,
            ...CALLER,
            environment: "development",
            domain: "example",
            releaseId: RELEASE_ID,
            status: "released",
          },
        },
      },
    ]);
  });

  it("answers why a release stopped", async () => {
    const { handle } = handler();
    releases.set(`development/example/${RELEASE_ID}`, {
      ...ASKED,
      status: "refused",
      step: "check-order",
      reason: "superseded",
    });

    const response = await handle(
      functionUrlEvent({ method: "GET", path: `${RELEASES}/${RELEASE_ID}` }),
    );

    expect(JSON.parse(response.body)).toMatchObject({
      status: "refused",
      step: "check-order",
      reason: "superseded",
    });
    expect(JSON.parse(response.body)).not.toHaveProperty("functionVersion");
  });

  // Every release is recorded, where it was asked for or promoted to.
  it("answers in an environment that takes its code by promotion", async () => {
    const { handle } = handler();
    releases.set(`staging/example/${RELEASE_ID}`, {
      ...RECORD,
      environment: "staging",
    });

    await expect(
      handle(
        functionUrlEvent({
          ...STAGING,
          method: "GET",
          path: `/ci/environments/staging/domains/example/releases/${RELEASE_ID}`,
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it.each([
    ["no release with that ID", "development/example"],
    ["only another domain's", "development/elsewhere"],
    ["only another environment's", "staging/example"],
  ])("answers 404 for a release the table holds %s", async (_, holder) => {
    const { handle } = handler();
    releases.set(`${holder}/${RELEASE_ID}`, RECORD);
    releases.delete(`development/example/${RELEASE_ID}`);

    await expect(
      handle(
        functionUrlEvent({
          method: "GET",
          path: `${RELEASES}/${RELEASE_ID}`,
        }),
      ),
    ).resolves.toMatchObject({
      statusCode: 404,
      body: body("Not found", "client_error"),
    });
    expect(logged[0]?.telemetry).toEqual({
      event: "ci_release_status_unknown",
      details: {
        ...REQUEST,
        ...CALLER,
        environment: "development",
        domain: "example",
        releaseId: RELEASE_ID,
      },
    });
  });

  // The ID is the caller's, so it is never looked up or logged unless it is one.
  it.each(["caller-chosen-text", RELEASE_ID.toUpperCase()])(
    "answers 404 for %s, which is no release's ID, looking nothing up",
    async (releaseId) => {
      const { handle } = handler();
      releases.set(`development/example/${releaseId}`, RECORD);

      await expect(
        handle(
          functionUrlEvent({
            method: "GET",
            path: `${RELEASES}/${releaseId}`,
          }),
        ),
      ).resolves.toMatchObject({ statusCode: 404 });
      expect(logged[0]?.telemetry).toEqual({
        event: "ci_release_status_unknown",
        details: {
          ...REQUEST,
          ...CALLER,
          environment: "development",
          domain: "example",
          reason: "release-id",
        },
      });
      expect(JSON.stringify(logged)).not.toContain(releaseId);
    },
  );

  it("answers 403 for a release of a domain the pipeline isn't allowed, looking nothing up", async () => {
    const { handle } = handler();
    releases.set(`development/elsewhere/${RELEASE_ID}`, RECORD);

    await expect(
      handle(
        functionUrlEvent({
          method: "GET",
          path: `/ci/environments/development/domains/elsewhere/releases/${RELEASE_ID}`,
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
  });

  it("answers 403 to a release by a pipeline that isn't allowed, looking at nothing", async () => {
    const { handle } = handler();

    await expect(
      handle(
        functionUrlEvent({
          path: "/ci/environments/development/domains/elsewhere/releases",
          body: RELEASE_BODY,
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(queued).toEqual([]);
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

  it.each(["POST", "GET"])(
    "answers 404 to a verified pipeline's %s of a path that is no route",
    async (method) => {
      const { handle } = handler();

      await expect(
        handle(
          functionUrlEvent({ method, path: "/ci/environments/development" }),
        ),
      ).resolves.toMatchObject({
        statusCode: 404,
        body: body("Not found", "client_error"),
      });
      expect(logged[0]?.telemetry).toEqual({
        event: "ci_route_unknown",
        details: { ...REQUEST, ...CALLER },
      });
    },
  );

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
