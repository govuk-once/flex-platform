// A domain's tests call its routes through this client, which runs the whole of the app with no
// network: the caller step, routing, validation and the checks on what a handler returns. It
// sends a caller token as the Frontdoor would, unsigned, since a domain never verifies one.

import { isRecord } from "@repo/utils/is-record";

import { CALLER_TOKEN_HEADER, MEDIA_TYPE_JSON } from "../../src/http.ts";
import { createApp } from "../../src/runtime/app.ts";
import { createLogger } from "../../src/runtime/logging.ts";
import type { DomainConfig } from "../../src/types.ts";

export interface TestCaller {
  readonly pairwiseId: string;
  readonly pushId: string;
}

export interface TestClientOptions {
  /** Who the requests are from. */
  readonly caller?: Partial<TestCaller>;
  /** How long each request has, as Lambda would report it. */
  readonly remainingTimeMs?: number;
}

export type LogLine = Readonly<Record<string, unknown>>;

// Functions rather than methods, so a test can take one from the client and call it alone.
export interface TestClient {
  readonly get: (path: string) => Promise<Response>;
  readonly delete: (path: string) => Promise<Response>;
  readonly post: (path: string, body?: unknown) => Promise<Response>;
  readonly put: (path: string, body?: unknown) => Promise<Response>;
  readonly patch: (path: string, body?: unknown) => Promise<Response>;
  /** Sends a request as it is, with the caller token added unless it has one. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Every line the domain has written, oldest first. */
  readonly lines: readonly LogLine[];
}

const ORIGIN = "https://domain.example";

const DEFAULT_CALLER: TestCaller = {
  pairwiseId: "test-user",
  pushId: "test-push-id",
};

const encodeSegment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A caller token for `caller`, in the form the Frontdoor sends, and unsigned. */
export function unsignedCallerToken(caller: TestCaller): string {
  return [
    encodeSegment({ alg: "none" }),
    encodeSegment(caller),
    "unsigned",
  ].join(".");
}

export function createTestClient(
  domain: DomainConfig,
  { caller = {}, remainingTimeMs = 10_000 }: TestClientOptions = {},
): TestClient {
  const lines: LogLine[] = [];

  const logger = createLogger(domain.name, {
    write: (line: string) => {
      const parsed: unknown = JSON.parse(line);

      if (isRecord(parsed)) lines.push(parsed);
    },
  });

  const app = createApp(domain, { logger });

  const token = unsignedCallerToken({ ...DEFAULT_CALLER, ...caller });

  const fetch = (request: Request) => {
    if (!request.headers.has(CALLER_TOKEN_HEADER)) {
      request.headers.set(CALLER_TOKEN_HEADER, token);
    }

    return app.fetch(request, { remainingTimeMs });
  };

  const send = (method: string, path: string, body?: unknown) =>
    fetch(
      new Request(new URL(path, ORIGIN), {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": MEDIA_TYPE_JSON },
            }),
      }),
    );

  return {
    get: (path) => send("GET", path),
    delete: (path) => send("DELETE", path),
    post: (path, body) => send("POST", path, body),
    put: (path, body) => send("PUT", path, body),
    patch: (path, body) => send("PATCH", path, body),
    fetch,
    lines,
  };
}
