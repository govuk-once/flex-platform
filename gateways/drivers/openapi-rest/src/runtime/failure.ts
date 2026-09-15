import { GatewayError } from "@repo/gateway-runtime";

import type { HeaderFailure } from "../headers.ts";

// The request-time half of the pair headers.ts describes: its default builds a TypeError, which
// is what a failure leaving createExecutor needs, while a request-time message reaches the log
// only as a GatewayError. It sits here rather than beside that default to keep headers.ts, which
// config/ imports, free of package imports. That is a property of that module and not a boundary:
// the driver's entry already reaches the runtime package through path.ts.
export const requestFailure: HeaderFailure = (message) =>
  new GatewayError("INTERNAL", message);
