import { bundleKey } from "@repo/shared-release/bundle-key";

import { releaseOf } from "../bundle.ts";
import {
  badRequest,
  notAccepted,
  releaseQueued,
  versionUnknown,
} from "../responses.ts";
import type { RouteHandler } from "../router.ts";
import { logOutcome } from "../telemetry.ts";

// Only a version the domain's pipeline uploaded can be released: the version is the domain's the
// pipeline is allowed for, and names the bundle it was uploaded with, whose key is under that
// domain.
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
  const logged = { ...details, version: asked.version };

  const sha256 = await options.findArtefact(target.domain, asked.version);
  if (sha256 === undefined) {
    logOutcome("ci_release_version_unknown", request(), logged);
    return versionUnknown(traceId);
  }
  // A version is claimed before its bundle is uploaded, so the bundle may never have been.
  const key = bundleKey(target.domain, sha256);
  const versionId = await options.findBundle(key);
  if (versionId === undefined) {
    logOutcome("ci_release_bundle_missing", request(), { ...logged, key });
    return versionUnknown(traceId);
  }

  const releaseId = await options.queueRelease({
    ...target,
    version: asked.version,
    sha256,
    versionId,
    runId: pipeline.runId,
    commit: pipeline.commit,
  });
  logOutcome("ci_release_queued", request(), {
    ...logged,
    key,
    versionId,
    releaseId,
  });
  return releaseQueued(traceId, {
    releaseId,
    ...target,
    version: asked.version,
    sha256,
  });
};
