// A domain's tests call its routes through this client, which runs the whole of `serve` with no
// network: the caller step, routing, validation and the checks on what a handler answers. It
// sends a caller token as the Frontdoor would, unsigned, since a domain never verifies one.

import { CALLER_TOKEN_HEADER, MEDIA_TYPE_JSON } from "../../src/http.ts";
import type { LogSink } from "../../src/runtime/log-writer.ts";
import { pinoSink } from "../../src/runtime/log-writer.ts";
import { createServe } from "../../src/runtime/serve.ts";
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
  /** Given each log line the domain writes, as JSON text. None are written otherwise. */
  readonly onLog?: (line: string) => void;
}

// Functions rather than methods, so a test can take one from the client and call it alone.
export interface TestClient {
  readonly get: (path: string) => Promise<Response>;
  readonly delete: (path: string) => Promise<Response>;
  readonly post: (path: string, body?: unknown) => Promise<Response>;
  readonly put: (path: string, body?: unknown) => Promise<Response>;
  readonly patch: (path: string, body?: unknown) => Promise<Response>;
  /** Sends a request as it is, with the caller token added unless it has one. */
  readonly request: (request: Request) => Promise<Response>;
}

const ORIGIN = "https://domain.invalid";

const DEFAULT_CALLER: TestCaller = {
  pairwiseId: "test-user",
  pushId: "test-push-id",
};

const segment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A caller token for `caller`, in the form the Frontdoor sends, and unsigned. */
export function testCallerToken(caller: TestCaller): string {
  return [segment({ alg: "none" }), segment(caller), "unsigned"].join(".");
}

const SILENT: LogSink = { write: () => undefined };

export function createTestClient(
  domain: DomainConfig,
  { caller = {}, remainingTimeMs = 10_000, onLog }: TestClientOptions = {},
): TestClient {
  const sink =
    onLog === undefined ? SILENT : pinoSink(domain.name, { write: onLog });

  const serve = createServe(domain, { sink });

  const token = testCallerToken({ ...DEFAULT_CALLER, ...caller });

  const request = (sent: Request) => {
    if (!sent.headers.has(CALLER_TOKEN_HEADER)) {
      sent.headers.set(CALLER_TOKEN_HEADER, token);
    }

    return serve(sent, { remainingTimeMs });
  };

  const send = (method: string, path: string, body?: unknown) =>
    request(
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
    request,
  };
}
