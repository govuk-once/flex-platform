import { bundleKey } from "@repo/shared-release/bundle-key";

import { uploadOf } from "../bundle.ts";
import {
  badRequest,
  notAccepted,
  uploadPresent,
  uploadSigned,
  versionTaken,
} from "../responses.ts";
import type { RouteHandler } from "../router.ts";
import { logOutcome } from "../telemetry.ts";

// Claims the version for the bundle, then signs an upload of the bundle to the key its hash names,
// under the domain the pipeline is allowed for.
//
// The version is claimed before anything is signed, because the API never sees the upload finish.
// So a version can be claimed with no bundle behind it, by a run that stopped before its upload,
// and the same bytes complete it by these same steps.
export const upload: RouteHandler = async (
  options,
  { event, traceId, pipeline, target, details, request },
) => {
  if (!options.publishes(target.environment)) {
    logOutcome("ci_upload_not_accepted", request(), details);
    return notAccepted(traceId, "uploads");
  }
  const asked = uploadOf(event);
  if (typeof asked === "string") {
    logOutcome("ci_upload_invalid", request(), { ...details, reason: asked });
    return badRequest(traceId);
  }

  const held = await options.claimVersion({
    domain: target.domain,
    version: asked.version,
    sha256: asked.sha256,
    runId: pipeline.runId,
    commit: pipeline.commit,
  });
  const key = bundleKey(target.domain, asked.sha256);
  const logged = { ...details, version: asked.version, key, size: asked.size };
  if (held !== asked.sha256) {
    logOutcome("ci_upload_version_taken", request(), logged);
    return versionTaken(traceId);
  }

  // Uploaded already, by an earlier run of this version, or under another version with the same
  // bytes.
  if ((await options.findBundle(key)) !== undefined) {
    logOutcome("ci_upload_present", request(), logged);
    return uploadPresent(traceId, asked);
  }

  const signed = await options.signUpload(key, asked);
  logOutcome("ci_upload_signed", request(), logged);
  return uploadSigned(traceId, signed);
};
