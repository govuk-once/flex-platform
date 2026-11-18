import { bundleKey, bundleOf } from "../bundle.ts";
import { badRequest, uploadSigned, uploadsNotAccepted } from "../responses.ts";
import type { RouteHandler } from "../router.ts";
import { logOutcome } from "../telemetry.ts";

// Signs an upload of a bundle to the key its hash names, under the domain the pipeline is allowed
// for.
export const upload: RouteHandler = async (
  options,
  { event, traceId, target, details, request },
) => {
  if (!options.takesUploads(target.environment)) {
    logOutcome("ci_upload_not_accepted", request(), details);
    return uploadsNotAccepted(traceId);
  }
  const bundle = bundleOf(event);
  if (typeof bundle === "string") {
    logOutcome("ci_upload_invalid", request(), { ...details, reason: bundle });
    return badRequest(traceId);
  }

  const key = bundleKey(target.domain, bundle.sha256);
  const signed = await options.signUpload(key, bundle);
  logOutcome("ci_upload_signed", request(), {
    ...details,
    key,
    size: bundle.size,
  });
  return uploadSigned(traceId, signed);
};
