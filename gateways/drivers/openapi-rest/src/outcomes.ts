import type { OpenApiRestOutcome } from "./types.ts";

// The statuses an upstream answers a request it carried out with, and the outcome each is to a
// caller. Shared, because two readers have to agree on it: the runtime maps a response by it,
// and deriving names an operation's outcomes by it, so a status one reads as an outcome the
// other declares a schema for.
const OUTCOME_BY_STATUS: Readonly<Record<number, OpenApiRestOutcome>> = {
  200: "ok",
  201: "created",
  202: "accepted",
  204: "no_content",
};

export function outcomeForStatus(
  status: number,
): OpenApiRestOutcome | undefined {
  return Object.hasOwn(OUTCOME_BY_STATUS, status)
    ? OUTCOME_BY_STATUS[status]
    : undefined;
}
