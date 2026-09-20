import type {
  DriverContext,
  SecretObject,
  SecretProvider,
} from "@repo/gateway-types";

export interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly calls: CapturedRequest[];
}

// Records each request and answers with the given responder. Never touches the network.
export function fakeFetch(
  respond: (req: CapturedRequest) => Response | Promise<Response>,
): FakeFetch {
  const calls: CapturedRequest[] = [];
  const impl: typeof fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const req = { url, init: init ?? {} };
    calls.push(req);
    return Promise.resolve(respond(req));
  };
  return { fetch: impl, calls };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A context that runs the attempt once with a live signal and applies no timeout, and keeps
// what the driver reported beside its result for a test to read.
export function passthroughContext(): DriverContext & {
  attempts: number;
  reported: Map<string, unknown>;
} {
  const ctx = {
    attempts: 0,
    reported: new Map<string, unknown>(),
    upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
      ctx.attempts += 1;
      return fn(new AbortController().signal);
    },
    meta(name: string, value: unknown): void {
      ctx.reported.set(name, value);
    },
  };
  return ctx;
}

export function headerOf(req: CapturedRequest, name: string): string | null {
  return new Headers(req.init.headers).get(name);
}

export interface FakeSecret {
  readonly provider: SecretProvider;
  // How many times get() has been called.
  readonly reads: () => number;
  // Serves a new value from the next get(), as a rotation seen after the cache age would.
  rotate(value: unknown): void;
  // Makes every get() reject until the next rotate(), as a failed read would.
  fail(error: Error): void;
}

// A secret provider under the test's control. Every get() answers with the current state, so
// a rotation or a failure is seen by the next request without recreating anything.
export function fakeSecret(value: unknown): FakeSecret {
  let current = value as SecretObject;
  let error: Error | undefined;
  let reads = 0;
  return {
    provider: {
      get() {
        reads += 1;
        return error === undefined
          ? Promise.resolve(current)
          : Promise.reject(error);
      },
    },
    reads: () => reads,
    rotate(nextValue) {
      current = nextValue as SecretObject;
      error = undefined;
    },
    fail(nextError) {
      error = nextError;
    },
  };
}
