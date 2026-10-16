import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import { authorizationToken } from "./authorization.ts";
import { internalError, unauthorized, verified } from "./responses.ts";
import type { RequestIds } from "./telemetry.ts";
import { logFailure, logOutcome } from "./telemetry.ts";
import type { VerifyToken } from "./token.ts";
import { requestTraceId } from "./trace-id.ts";
import type { CloudFrontResultResponse, OriginRequestEvent } from "./types.ts";

export interface OriginRequestOptions {
  readonly verifyToken: VerifyToken;
  readonly region: string;
  readonly functionVersion: string;
}

// For now it verifies the token and answers the request itself: it signs nothing and routes
// nowhere. Every error after reading the IDs is answered with a 500, so the runtime never prints
// an error, whose text can hold a claim. If reading the IDs failed, CloudFront would answer the
// request itself and forward nothing.
export function createOriginRequestHandler(options: OriginRequestOptions) {
  return async (
    event: OriginRequestEvent,
  ): Promise<CloudFrontResultResponse> => {
    const { config, request } = event.Records[0].cf;
    const ids: RequestIds = {
      traceId: requestTraceId(
        request.headers["x-correlation-id"]?.[0]?.value,
        config.requestId,
        Date.now() / 1000,
      ),
      requestId: config.requestId,
    };

    try {
      const bearer = authorizationToken(request.headers);
      if (!("token" in bearer)) {
        const event = bearer.missing
          ? "lae_token_missing"
          : "lae_token_invalid";
        logOutcome(event, ids, bearer.reason);
        return unauthorized(ids.traceId);
      }

      const rejection = await options.verifyToken(bearer.token);
      if (rejection !== undefined) {
        const event =
          rejection.reason === "expired"
            ? "lae_token_expired"
            : "lae_token_invalid";
        logOutcome(event, ids, rejection.reason);
        return unauthorized(ids.traceId);
      }

      logOutcome("lae_token_verified", ids);
      return verified(ids.traceId, options);
    } catch (error) {
      logFailure(ids, describeUnexpectedError(error));
      return internalError(ids.traceId);
    }
  };
}
