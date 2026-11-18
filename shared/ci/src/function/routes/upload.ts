import { bundleKey } from "@repo/shared-release/bundle-key";

import { bundleOf } from "../bundle.ts";
import { badRequest, notAccepted, uploadSigned } from "../responses.ts";
import type { RouteHandler } from "../router.ts";
import { logOutcome } from "../telemetry.ts";

// Signs an upload of a bundle to the key its hash names, under the domain the pipeline is allowed
// for.
export const upload: RouteHandler = async (
  options,
  { event, traceId, target, details, request },
) => {
  if (!options.publishes(target.environment)) {
    logOutcome("ci_upload_not_accepted", request(), details);
    return notAccepted(traceId, "uploads");
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
