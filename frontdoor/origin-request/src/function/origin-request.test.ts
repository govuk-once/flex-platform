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
import { createRequestSigner, type SignRequest } from "./sign.ts";
import type { VerifyToken } from "./token.ts";
import { createTokenVerifier } from "./token.ts";
import type {
  CloudFrontRequest,
  CloudFrontResultResponse,
  OriginRequestEvent,
} from "./types.ts";

const HOST = "udp.development.flex-domain00.once.service.gov.uk";
const ROUTES = new Map([["udp", HOST]]);

const SIGN = createRequestSigner(() => ({
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
  sessionToken: "session-token",
}));

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

function handlerWith(verifyToken?: VerifyToken, sign: SignRequest = SIGN) {
  const { fetcher } = fakeFetcher({
    [jwksUri(ISSUER)]: jwks([{ kid: KID, key: ISSUER_KEY }]),
  });
  return createOriginRequestHandler({
    verifyToken: verifyToken ?? createTokenVerifier(ISSUERS, fetcher),
    routes: ROUTES,
    sign,
  });
}

function asRequest(
  result: CloudFrontRequest | CloudFrontResultResponse,
): CloudFrontRequest {
  if ("status" in result) throw new Error(`answered ${result.status}`);
  return result;
}

function asResponse(
  result: CloudFrontRequest | CloudFrontResultResponse,
): CloudFrontResultResponse {
  if (!("status" in result)) throw new Error("forwarded the request");
  return result;
}

function withBody(
  body: Partial<CloudFrontRequest["body"]>,
): OriginRequestEvent {
  const event = originRequestEvent();
  event.Records[0].cf.request.method = "POST";
  event.Records[0].cf.request.body = {
    action: "read-only",
    data: Buffer.from('{"name":"value"}').toString("base64"),
    encoding: "base64",
    inputTruncated: false,
    ...body,
  };
  return event;
}

const INTERNAL_ERROR = {
  status: "500",
  statusDescription: "Internal Server Error",
  headers: {
    "content-type": [{ key: "Content-Type", value: "application/json" }],
    "x-correlation-id": [{ key: "X-Correlation-Id", value: TRACE_ID }],
    "x-rejected-by": [{ key: "X-Rejected-By", value: "lambda-edge" }],
  },
  body: '{"message":"Internal server error","type":"server_error"}',
  bodyEncoding: "text",
};

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

  it("forwards a verified request to its domain, signed, without the caller's token", async () => {
    const event = originRequestEvent();
    const received = event.Records[0].cf.request;

    const forwarded = asRequest(await handlerWith()(event));

    expect(forwarded.uri).toBe("/v1/identity");
    expect(forwarded.querystring).toBe(received.querystring);
    expect(forwarded.origin).toEqual({
      custom: {
        customHeaders: {},
        domainName: HOST,
        keepaliveTimeout: 5,
        path: "",
        port: 443,
        protocol: "https",
        readTimeout: 30,
        sslProtocols: ["TLSv1.2"],
      },
    });
    expect(forwarded.headers.host).toEqual([{ key: "Host", value: HOST }]);
    expect(forwarded.headers.authorization?.[0]?.value).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-2\/execute-api\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token;x-correlation-id;x-flex-secure, Signature=[0-9a-f]{64}$/,
    );
    expect(forwarded.headers["x-amz-security-token"]).toEqual([
      { key: "X-Amz-Security-Token", value: "session-token" },
    ]);
    // Until the signed caller token is built: a fixed value, signed, holding nothing of the caller.
    expect(forwarded.headers["x-flex-secure"]).toEqual([
      { key: "X-Flex-Secure", value: "placeholder" },
    ]);
    // What CloudFront gave it stays, unsigned.
    for (const name of [
      "x-correlation-id",
      "via",
      "user-agent",
      "x-forwarded-for",
    ]) {
      expect(forwarded.headers[name]).toEqual(received.headers[name]);
    }
    expect(loggedLines()).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event: "lae_forwarded",
          details: { traceId: TRACE_ID, requestId: REQUEST_ID, domain: "udp" },
        },
      },
    ]);
  });

  it("signs the body it forwards, and leaves the body as it was", async () => {
    const sign = vi.fn<SignRequest>(SIGN);
    const event = withBody({});
    const body = event.Records[0].cf.request.body;

    const forwarded = asRequest(await handlerWith(undefined, sign)(event));

    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        body: new Uint8Array(Buffer.from('{"name":"value"}')),
      }),
    );
    expect(forwarded.body).toEqual(body);
  });

  it("answers a verified request for a domain it can't route with the app's 404", async () => {
    const event = originRequestEvent();
    event.Records[0].cf.request.uri = "/app/unknown/v1";

    expect(asResponse(await handlerWith()(event))).toEqual({
      status: "404",
      statusDescription: "Not found",
      headers: {
        "content-type": [{ key: "Content-Type", value: "application/json" }],
        "x-correlation-id": [{ key: "X-Correlation-Id", value: TRACE_ID }],
        "x-rejected-by": [{ key: "X-Rejected-By", value: "lambda-edge" }],
      },
      body: '{"message":"Not found","type":"client_error"}',
      bodyEncoding: "text",
    });
    expect(loggedLines()).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event: "lae_route_unknown",
          details: { traceId: TRACE_ID, requestId: REQUEST_ID },
        },
      },
    ]);
  });

  it.each([
    ["a truncated body", withBody({ inputTruncated: true }), SIGN],
    [
      "a signature that can't be made",
      originRequestEvent(),
      () => Promise.reject(new Error("no credentials")),
    ],
    [
      "a signing header CloudFront would refuse",
      originRequestEvent(),
      () => Promise.resolve({ authorization: "AWS4\nsplit" }),
    ],
  ])("fails closed on %s, forwarding nothing", async (_, event, sign) => {
    const response = await handlerWith(undefined, sign)(event);

    expect(response).toEqual(INTERNAL_ERROR);
    expect(loggedLines()).toEqual([
      expect.objectContaining({
        level: "ERROR",
        telemetry: expect.objectContaining({ event: "lae_failed" }) as unknown,
      }),
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
      routes: ROUTES,
      sign: SIGN,
    });

    const response = await handler(originRequestEvent());

    expect(response).toEqual(INTERNAL_ERROR);
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

    expect(asResponse(response).status).toBe("500");
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

      const output = [
        JSON.stringify(response),
        ...log.mock.calls.map(String),
      ].join("\n");
      expect(output).not.toContain("SYNTHETIC");
      expect(sharedRun(output, value)).toBeUndefined();
    });

    it("when verification throws an error that quotes the token", async () => {
      const handler = handlerWith((value) => {
        throw new Error(`Invalid token ${value} SYNTHETIC`);
      });

      const response = await handler(withToken(verifiedToken));

      const output = [
        JSON.stringify(response),
        ...log.mock.calls.map(String),
      ].join("\n");
      expect(output).not.toContain("SYNTHETIC");
      expect(sharedRun(output, verifiedToken)).toBeUndefined();
    });
  });
});
