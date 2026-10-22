import { AsyncLocalStorage } from "node:async_hooks";

import type { SecureValue } from "@repo/gateway-core";

// What the client sends on its caller's behalf, for the whole of the caller's own invocation. The
// SDK runs a domain's handler inside withCallerContext, and every call made from it, however many
// awaits deep, carries the context. A call made outside one has none. Only the client reads the
// storage: the `caller` entry exports the function that sets it and nothing that reads it, so the
// values, a token among them later, are not offered to the rest of a domain's code.

/** The caller's asserted values, which the gateway compares with its secure bindings. */
export interface SecureContext {
  readonly values: Readonly<Record<string, SecureValue>>;
  readonly signature: string;
}

export interface CallerContext {
  /**
   * When the caller stops waiting, in epoch milliseconds. A call is abandoned then, and one made
   * after it is not sent. The caller keeps its own margin for answering after a call.
   */
  readonly deadline: number;
  /**
   * Required by an operation with secure bindings. Without it a call sends no values, which only
   * an operation with none accepts. The gateway does not verify the signature yet.
   */
  readonly secure?: SecureContext;
}

const storage = new AsyncLocalStorage<CallerContext>();

/** Runs `fn` with `context` as the context of every gateway call made from it. */
export function withCallerContext<T>(context: CallerContext, fn: () => T): T {
  if (!Number.isFinite(context.deadline)) {
    throw new TypeError(
      "A caller's deadline must be a finite number of milliseconds since the epoch.",
    );
  }
  return storage.run(context, fn);
}

export function currentCallerContext(): CallerContext | undefined {
  return storage.getStore();
}
