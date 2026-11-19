import { isReleaseId } from "@repo/shared-release/release-id";
import { heldValue } from "@repo/utils/held-value";

import { notFound, releaseStatus } from "../responses.ts";
import type { RouteHandler } from "../router.ts";
import { logOutcome } from "../telemetry.ts";

// Answers how a release went, as the release table records it: one of the domain's the pipeline
// is allowed for, in that environment, since the table keeps a release under both. Any
// environment, publishing or not, since every release is recorded.
export const status: RouteHandler = async (
  options,
  { traceId, target, params, details, request },
) => {
  // Still the caller's: only an ID of a release's form is looked up or logged.
  const releaseId = heldValue(params, "releaseId");
  if (!isReleaseId(releaseId)) {
    logOutcome("ci_release_status_unknown", request(), {
      ...details,
      reason: "release-id",
    });
    return notFound(traceId);
  }

  // A release recorded before releases had versions doesn't read, and is answered as none.
  const record = await options.findRelease({ ...target, id: releaseId });
  if (record === undefined) {
    logOutcome("ci_release_status_unknown", request(), {
      ...details,
      releaseId,
    });
    return notFound(traceId);
  }

  logOutcome("ci_release_status", request(), {
    ...details,
    releaseId,
    status: record.status,
  });
  return releaseStatus(traceId, record);
};
