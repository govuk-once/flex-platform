import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeFetcher,
  ISSUER,
  ISSUER_KEY,
  ISSUERS,
  jwks,
  jwksUri,
  KID,
  NOW,
  originRequestEvent,
  OTHER_KEY,
  REQUEST_ID,
  token,
  TRACE_ID,
} from "../../test/helpers.ts";
import { createOriginRequestHandler } from "./origin-request.ts";
import type { VerifyToken } from "./token.ts";
import { createTokenVerifier } from "./token.ts";
import type { OriginRequestEvent } from "./types.ts";

const RUNTIME = { region: "eu-west-2", functionVersion: "7" };

const UNAUTHORIZED = {
  status: "401",
  statusDescription: "Unauthorized",
  headers: {
    "content-type": [{ key: "Content-Type", value: "application/json" }],
    "x-correlation-id": [{ key: "X-Correlation-Id", value: TRACE_ID }],
    "x-rejected-by": [{ key: "X-Rejected-By", value: "lambda-edge" }],
  },
  body: '{"message":"Unauthorized","type":"auth_error"}',
  bodyEncoding: "text",
};

function handlerWith(verifyToken?: VerifyToken) {
  const { fetcher } = fakeFetcher({
    [jwksUri(ISSUER)]: jwks([{ kid: KID, key: ISSUER_KEY }]),
  });
  return createOriginRequestHandler({
    verifyToken: verifyToken ?? createTokenVerifier(ISSUERS, fetcher),
    ...RUNTIME,
  });
}

function withToken(value: string): OriginRequestEvent {
  return originRequestEvent({
    headers: { authorization: `Bearer ${value}`, "x-correlation-id": TRACE_ID },
  });
}

// Any 16 characters of the token in the output, not only the whole token or a whole segment.
function sharedRun(output: string, value: string): string | undefined {
  for (let i = 0; i + 16 <= value.length; i++) {
    const run = value.slice(i, i + 16);
    if (output.includes(run)) return run;
  }
  return undefined;
}

let log: MockInstance<typeof console.log>;

function loggedLines(): unknown[] {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
}

describe("createOriginRequestHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW * 1000 });
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers a verified token itself, with fixed diagnostic fields", async () => {
    const response = await handlerWith()(originRequestEvent());

    expect(response).toEqual({
      status: "200",
      statusDescription: "OK",
      headers: {
        "content-type": [{ key: "Content-Type", value: "application/json" }],
        "x-correlation-id": [{ key: "X-Correlation-Id", value: TRACE_ID }],
      },
      body: JSON.stringify({
        outcome: "verified",
        traceId: TRACE_ID,
        region: "eu-west-2",
        functionVersion: "7",
      }),
      bodyEncoding: "text",
    });
    expect(loggedLines()).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event: "lae_token_verified",
          details: { traceId: TRACE_ID, requestId: REQUEST_ID },
        },
      },
    ]);
  });

  it.each([
    ["lae_token_missing", "no-header", originRequestEvent({ headers: {} })],
    [
      "lae_token_missing",
      "no-token",
      originRequestEvent({ headers: { authorization: "Bearer" } }),
    ],
    [
      "lae_token_invalid",
      "repeated",
      originRequestEvent({
        headers: { authorization: [`Bearer ${token()}`, `Bearer ${token()}`] },
      }),
    ],
    [
      "lae_token_invalid",
      "scheme",
      originRequestEvent({ headers: { authorization: `Basic ${token()}` } }),
    ],
    ["lae_token_invalid", "signature", withToken(token({ key: OTHER_KEY }))],
    [
      "lae_token_invalid",
      "client",
      withToken(token({ payload: { client_id: "another" } })),
    ],
    [
      "lae_token_expired",
      "expired",
      withToken(token({ payload: { exp: NOW - 1 } })),
    ],
  ])("answers %s (%s) with the app's 401", async (event, reason, request) => {
    const response = await handlerWith()(request);

    expect(response).toEqual(UNAUTHORIZED);
    expect(loggedLines()).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event,
          details: { traceId: TRACE_ID, requestId: REQUEST_ID, reason },
        },
      },
    ]);
  });

  it("fails closed when the issuer's keys can't be fetched", async () => {
    const { fetcher } = fakeFetcher({});
    const handler = createOriginRequestHandler({
      verifyToken: createTokenVerifier(ISSUERS, fetcher),
      ...RUNTIME,
    });

    const response = await handler(originRequestEvent());

    expect(response).toEqual({
      status: "500",
      statusDescription: "Internal Server Error",
      headers: {
        "content-type": [{ key: "Content-Type", value: "application/json" }],
        "x-correlation-id": [{ key: "X-Correlation-Id", value: TRACE_ID }],
        "x-rejected-by": [{ key: "X-Rejected-By", value: "lambda-edge" }],
      },
      body: '{"message":"Internal server error","type":"server_error"}',
      bodyEncoding: "text",
    });
    expect(loggedLines()).toEqual([
      {
        level: "ERROR",
        message: "telemetry",
        telemetry: {
          event: "lae_failed",
          details: {
            traceId: TRACE_ID,
            requestId: REQUEST_ID,
            frames: expect.any(Array) as unknown,
          },
        },
      },
    ]);
  });

  it("logs where an error was thrown, and nothing it says", async () => {
    const handler = handlerWith(() => {
      throw new TypeError("SYNTHETIC-ERROR-TEXT");
    });

    const response = await handler(originRequestEvent());

    expect(response.status).toBe("500");
    const line = log.mock.calls.map(String).join("\n");
    expect(line).not.toContain("SYNTHETIC");
    expect(line).toMatch(/origin-request\.test\.ts:\d+:\d+/);
  });

  describe("never logs or answers with the token or its claims", () => {
    const claims = {
      iss: ISSUER,
      client_id: "SYNTHETIC-CLIENT",
      token_use: "SYNTHETIC-USE",
      username: "SYNTHETIC-PAIRWISE-ID",
    };
    const verifiedToken = token({
      payload: { username: "SYNTHETIC-PAIRWISE-ID" },
    });
    const refused = [
      token({ payload: { ...claims, iss: "https://SYNTHETIC-ISSUER" } }),
      token({ payload: { ...claims, token_use: "access" } }),
      token({ payload: claims }),
      token({ payload: { ...claims, exp: NOW - 1 } }),
      token({ payload: claims, key: OTHER_KEY }),
    ];

    it.each([verifiedToken, ...refused])("for %#", async (value) => {
      const response = await handlerWith()(withToken(value));

      const output = [response.body, ...log.mock.calls.map(String)].join("\n");
      expect(output).not.toContain("SYNTHETIC");
      expect(sharedRun(output, value)).toBeUndefined();
    });

    it("when verification throws an error that quotes the token", async () => {
      const handler = handlerWith((value) => {
        throw new Error(`Invalid token ${value} SYNTHETIC`);
      });

      const response = await handler(withToken(verifiedToken));

      const output = [response.body, ...log.mock.calls.map(String)].join("\n");
      expect(output).not.toContain("SYNTHETIC");
      expect(sharedRun(output, verifiedToken)).toBeUndefined();
    });
  });
});
