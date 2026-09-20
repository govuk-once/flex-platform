import { GatewayError } from "@repo/gateway-runtime";
import type { DriverContext } from "@repo/gateway-types";

import { validateHeaders } from "../headers.ts";
import { outcomeForStatus } from "../outcomes.ts";
import { hasControlCharacter, hasDotSegment } from "../path.ts";
import type {
  OpenApiRestCall,
  OpenApiRestClient,
  OpenApiRestResponse,
  QueryValue,
} from "../types.ts";
import { requestFailure } from "./failure.ts";
import { checkCall, sendRequest, serialiseJson } from "./http.ts";
import type { CompiledOperation } from "./operation.ts";
import { errorForStatus } from "./response.ts";

// The headers the gateway's authentication adds to one request, already validated and known
// to be among the names it declared. Called inside the timed attempt, so a secret refresh or a
// token exchange counts against the budget and the signal fires when it runs out.
export type AuthHeaders = (
  operation: string,
  signal: AbortSignal,
) => Promise<Headers>;

export interface ClientDeps {
  readonly target: URL;
  readonly fetch: typeof fetch;
  readonly staticHeaders: Headers;
  readonly auth: AuthHeaders;
  // Lowercased names nothing at request time may set: the headers authentication owns.
  readonly reservedHeaders: ReadonlySet<string>;
  readonly maxResponseBytes: number;
}

function joinPath(basePath: string, path: string): string {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return base + path;
}

// A query is mapped from an operation's parameters, or already written when an authentication
// flow's endpoint carries its own. A written one is set as it stands, so the flow's encoding
// and any repeated name survive.
export function buildUrl(
  target: URL,
  path: string,
  query?: Readonly<Record<string, QueryValue>> | string,
): URL {
  if (!path.startsWith("/")) {
    throw new GatewayError("INTERNAL", `Request path must start with "/"`);
  }
  // Before the dot-segment check reports what it found, since the parser drops three of these
  // and would otherwise rewrite the path without saying so.
  if (hasControlCharacter(path)) {
    throw new GatewayError(
      "INTERNAL",
      "Request path must not contain a control character",
    );
  }
  if (hasDotSegment(path)) {
    throw new GatewayError(
      "INTERNAL",
      "Request path must not contain a dot segment",
    );
  }
  const url = new URL(target.href);
  // Assigned, not resolved: a path cannot move the request to another host.
  url.pathname = joinPath(target.pathname, path);
  if (typeof query === "string") {
    url.search = query;
    return url;
  }

  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value as readonly (string | number | boolean)[]) {
        search.append(name, String(item));
      }
    } else {
      search.append(name, String(value));
    }
  }
  url.search = search.toString();
  return url;
}

export function createClient(
  ctx: DriverContext,
  op: CompiledOperation,
  deps: ClientDeps,
): OpenApiRestClient {
  const { name, upstream } = op;
  const template = `${upstream.method} ${upstream.template}`;
  const where = `for operation "${name}" (${template})`;

  async function request(call: OpenApiRestCall): Promise<OpenApiRestResponse> {
    checkCall(call.method, call.body !== undefined, `Operation "${name}"`);

    const url = buildUrl(deps.target, call.path, call.query);
    const callHeaders = validateHeaders(
      call.headers ?? {},
      `Operation "${name}" call headers`,
      requestFailure,
    );
    for (const key of callHeaders.keys()) {
      if (deps.reservedHeaders.has(key)) {
        throw new GatewayError(
          "INTERNAL",
          `Operation "${name}": call header "${key}" is reserved by the driver's authentication and cannot be set`,
        );
      }
    }
    const body =
      call.body !== undefined
        ? serialiseJson(call.body, `for operation "${name}"`)
        : undefined;

    // Everything from authentication to the last body byte happens inside one attempt, so the
    // policy timeout bounds the whole exchange.
    return ctx.upstream(async (signal) => {
      // Later layers override earlier ones: driver defaults, static headers, the call's own,
      // then authentication, which nothing before it may name anyway.
      const headers = new Headers({ accept: "application/json" });
      for (const [key, value] of deps.staticHeaders) headers.set(key, value);
      for (const [key, value] of callHeaders) headers.set(key, value);
      for (const [key, value] of await deps.auth(name, signal)) {
        headers.set(key, value);
      }
      if (body !== undefined) headers.set("content-type", "application/json");

      return sendRequest(
        deps,
        {
          method: call.method,
          url,
          headers,
          ...(body !== undefined ? { body } : {}),
        },
        signal,
        where,
      );
    });
  }

  function mapResponse(response: OpenApiRestResponse) {
    const outcome = outcomeForStatus(response.status);
    if (outcome === undefined) {
      throw errorForStatus(response.status, name, template);
    }
    return {
      outcome,
      data: outcome === "no_content" ? null : response.json(),
    };
  }

  return {
    prepare: (input) => op.prepare(input),
    request,
    mapResponse,
    invoke: async (call) => mapResponse(await request(call)),
  };
}
