import type { OperationResult } from "@repo/gateway-types";

import type { OpenApiRestClient, OpenApiRestHandler } from "../types.ts";

// Marks a handler as written for this driver. The brand is type-level only; the function is
// returned unchanged. Annotate `input` to state what the operation's input schema describes:
// the runtime has validated it against that schema before the handler runs. The outcomes the
// handler returns are inferred and kept, so both can be checked against the schemas.
export function defineHandler<TInput, TOutcome extends string>(
  fn: (
    input: TInput,
    client: OpenApiRestClient,
  ) => Promise<OperationResult<TOutcome>>,
): OpenApiRestHandler<TInput, TOutcome> {
  return fn as unknown as OpenApiRestHandler<TInput, TOutcome>;
}
