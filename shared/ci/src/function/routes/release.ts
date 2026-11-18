import { bundleKey } from "@repo/shared-release/bundle-key";

import { releaseOf } from "../bundle.ts";
import {
  badRequest,
  bundleMissing,
  notAccepted,
  releaseQueued,
} from "../responses.ts";
import type { RouteHandler } from "../router.ts";
import { logOutcome } from "../telemetry.ts";

// Only a bundle the domain's pipeline uploaded can be released: the key is under the domain the
// pipeline is allowed for, and named by the hash it asks for.
export const release: RouteHandler = async (
  options,
  { event, traceId, pipeline, target, details, request },
) => {
  if (!options.publishes(target.environment)) {
    logOutcome("ci_release_not_accepted", request(), details);
    return notAccepted(traceId, "releases");
  }
  const asked = releaseOf(event);
  if (typeof asked === "string") {
    logOutcome("ci_release_invalid", request(), { ...details, reason: asked });
    return badRequest(traceId);
  }

  const key = bundleKey(target.domain, asked.sha256);
  const versionId = await options.findBundle(key);
  if (versionId === undefined) {
    logOutcome("ci_release_bundle_missing", request(), { ...details, key });
    return bundleMissing(traceId);
  }

  const releaseId = await options.queueRelease({
    ...target,
    sha256: asked.sha256,
    versionId,
    runId: pipeline.runId,
    commit: pipeline.commit,
  });
  logOutcome("ci_release_queued", request(), {
    ...details,
    key,
    versionId,
    releaseId,
  });
  return releaseQueued(traceId, {
    releaseId,
    ...target,
    sha256: asked.sha256,
  });
};
