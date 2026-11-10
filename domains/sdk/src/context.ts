// The request's context, reachable from anywhere a handler calls into, so a service module need
// not be handed the logger or the caller. One store per request, opened by the route around its
// handler and closed when the handler settles.

import { AsyncLocalStorage } from "node:async_hooks";

import type { Caller } from "./caller.ts";
import type { Log } from "./logging/logger.ts";

export interface RequestStore {
  readonly log: Log;
  readonly caller: Caller;
  /** The handler's context, as the route built it. */
  readonly context: unknown;
}

export const requestStorage: AsyncLocalStorage<RequestStore> =
  new AsyncLocalStorage<RequestStore>();

export function currentRequest(): RequestStore {
  const store = requestStorage.getStore();
  if (store === undefined) {
    throw new Error(
      "There is no request: this can only be read while a route's handler runs.",
    );
  }
  return store;
}

/** The caller of the request being handled. */
export function currentCaller(): Caller {
  return currentRequest().caller;
}
