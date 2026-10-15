import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import { authorizationToken } from "./authorization.ts";
import { forward } from "./forward.ts";
import { internalError, notFound, unauthorized } from "./responses.ts";
import { routeFor, type Routes } from "./route.ts";
import type { SignRequest } from "./sign.ts";
import type { RequestIds } from "./telemetry.ts";
import { logFailure, logOutcome } from "./telemetry.ts";
import type { VerifyToken } from "./token.ts";
import { requestTraceId } from "./trace-id.ts";
import type {
  CloudFrontRequest,
  CloudFrontResultResponse,
  OriginRequestEvent,
} from "./types.ts";

export interface OriginRequestOptions {
  readonly verifyToken: VerifyToken;
  readonly routes: Routes;
  readonly sign: SignRequest;
}

// Verify the token, route the request to its domain, and sign it. Every error after reading the
// IDs is answered with a 500, so the runtime never prints an error, whose text can hold a claim,
// and nothing unsigned is ever forwarded. If reading the IDs failed, CloudFront would answer the
// request itself and forward nothing.
export function createOriginRequestHandler(options: OriginRequestOptions) {
  return async (
    event: OriginRequestEvent,
  ): Promise<CloudFrontRequest | CloudFrontResultResponse> => {
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
          ? "origin_request_token_missing"
          : "origin_request_token_invalid";
        logOutcome(event, ids, { reason: bearer.reason });
        return unauthorized(ids.traceId);
      }

      const rejection = await options.verifyToken(bearer.token);
      if (rejection !== undefined) {
        const event =
          rejection.reason === "expired"
            ? "origin_request_token_expired"
            : "origin_request_token_invalid";
        logOutcome(event, ids, { reason: rejection.reason });
        return unauthorized(ids.traceId);
      }

      // After the token, so a caller without one learns nothing about which domains exist.
      const route = routeFor(request.uri, options.routes);
      if (route === undefined) {
        logOutcome("origin_request_route_unknown", ids);
        return notFound(ids.traceId);
      }

      const forwarded = await forward(request, route, options.sign);
      logOutcome("origin_request_forwarded", ids, { domain: route.domain });
      return forwarded;
    } catch (error) {
      logFailure(ids, describeUnexpectedError(error));
      return internalError(ids.traceId);
    }
  };
}
