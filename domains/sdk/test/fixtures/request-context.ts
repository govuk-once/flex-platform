// What the SDK gives a handler, for a test that calls one directly. The caller is read from a
// test token, as `serve` reads one, so its IDs carry their types without a cast. Each call builds
// a new context, so no test shares another's abort signal.

import type { RequestContext } from "../../src/handler.ts";
import { readCallerToken } from "../../src/runtime/caller-token.ts";
import { testCallerToken } from "./test-client.ts";

export function requestContext(): RequestContext {
  const callerToken = readCallerToken(
    testCallerToken({ pairwiseId: "test-user", pushId: "test-push-id" }),
  );

  if (callerToken === undefined) {
    throw new Error("The test caller token is unreadable");
  }

  const { caller } = callerToken;

  return {
    caller,
    signal: new AbortController().signal,
    log: { info: () => undefined, warn: () => undefined },
  };
}
