import { GatewayError } from "@repo/gateway-runtime";

import type { OpenApiRestAuthTransport } from "../config/auth.ts";
import { validateHeaders } from "../headers.ts";
import { buildUrl } from "./client.ts";
import { requestFailure } from "./failure.ts";
import { checkCall, sendRequest, serialiseJson } from "./http.ts";
import { isCleartextAllowed } from "./target.ts";

export interface AuthTransportDeps {
  readonly fetch: typeof fetch;
  readonly target: URL;
  readonly maxResponseBytes: number;
}

const WHERE = "for an authentication request";

// A token endpoint's address is deployment configuration and usually comes from the secret, so
// it is validated here, at request time, and never repeated in a diagnostic.
function resolveUrl(target: URL, url: string): URL {
  if (url.startsWith("/")) {
    // Split the query off: a path is taken literally and encoded whole, "?" included.
    const queryAt = url.indexOf("?");
    if (queryAt === -1) return buildUrl(target, url);
    return buildUrl(target, url.slice(0, queryAt), url.slice(queryAt + 1));
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GatewayError(
      "INTERNAL",
      `Authentication request URL must be an absolute http or https URL or a path`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GatewayError(
      "INTERNAL",
      "Authentication request URL must use http or https",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new GatewayError(
      "INTERNAL",
      "Authentication request URL must not embed credentials",
    );
  }
  // A token exchange carries the credentials that obtain the credential, so it takes the same
  // rule as the upstream target.
  if (!isCleartextAllowed(parsed)) {
    throw new GatewayError(
      "INTERNAL",
      "Authentication request URL must use https; http is accepted only for a loopback host",
    );
  }
  return parsed;
}

// The one way an authentication flow reaches the network. It sends with the signal the flow
// was given, so the operation's attempt bounds a token exchange, and it applies the same body
// limit, header checks and error replacement as an operation's own request. Statuses are
// returned as they are: what a token endpoint's answer means is the flow's decision.
export function createAuthTransport(
  deps: AuthTransportDeps,
): OpenApiRestAuthTransport {
  return {
    // Async so that every failure, a bad URL included, leaves as a rejection.
    async request(call, signal) {
      if (call.json !== undefined && call.form !== undefined) {
        throw new GatewayError(
          "INTERNAL",
          "Authentication request: a call carries a JSON body or a form body, not both",
        );
      }
      const hasBody = call.json !== undefined || call.form !== undefined;
      checkCall(call.method, hasBody, "Authentication request");

      const url = resolveUrl(deps.target, call.url);
      const headers = new Headers({ accept: "application/json" });
      for (const [key, value] of validateHeaders(
        call.headers ?? {},
        "Authentication request headers",
        requestFailure,
      )) {
        headers.set(key, value);
      }
      let body: string | undefined;
      if (call.json !== undefined) {
        body = serialiseJson(call.json, WHERE);
        headers.set("content-type", "application/json");
      } else if (call.form !== undefined) {
        body = new URLSearchParams(call.form).toString();
        headers.set("content-type", "application/x-www-form-urlencoded");
      }

      return sendRequest(
        deps,
        {
          method: call.method,
          url,
          headers,
          ...(body !== undefined ? { body } : {}),
        },
        signal,
        WHERE,
      );
    },
  };
}
