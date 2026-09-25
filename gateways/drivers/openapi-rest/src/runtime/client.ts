import { GatewayError } from "@repo/gateway-runtime";
import type { DriverContext } from "@repo/gateway-types";

import type { OpenApiRestAuthRequest } from "../config/auth.ts";
import { validateHeaders } from "../headers.ts";
import { type CompiledMetadata, readMetadata } from "../metadata.ts";
import { outcomeForStatus } from "../outcomes.ts";
import { hasControlCharacter, hasDotSegment } from "../path.ts";
import type {
  HttpMethod,
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
export type AuthHeaders = (request: OpenApiRestAuthRequest) => Promise<Headers>;

export interface ClientDeps {
  readonly target: URL;
  readonly fetch: typeof fetch;
  readonly staticHeaders: Headers;
  readonly auth: AuthHeaders;
  // Lowercased names nothing at request time may set: the headers authentication owns.
  readonly reservedHeaders: ReadonlySet<string>;
  readonly maxResponseBytes: number;
  // What the gateway reports beside a result, and the response header each is read from.
  readonly metadata: readonly CompiledMetadata[];
  // Reads the secret again from the store and has every authentication part drop what it
  // holds. Absent for a gateway that sends no credential, whose refusals are not about one.
  readonly reauthenticate?: () => Promise<void>;
}

// The statuses with which an upstream refuses the credentials it was sent. A rotated secret
// shows as one: the upstream has already replaced what the cached copy holds.
const REFUSED: ReadonlySet<number> = new Set([401, 403]);

// The methods sent once more after a refusal. A 401 or a 403 does not show that the upstream
// refused before acting: API Gateway passes on whatever status the service behind it chose, and
// that service may have done the work first. Only a GET, which reads, can be sent twice.
const REPLAYED: ReadonlySet<HttpMethod> = new Set(["GET"]);

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
  // A space as %20, not as the + that form encoding writes: %20 is a space to every reader of a
  // URL, where + is one only to a form decoder, and a signature over the query encodes it as
  // %20. A literal + is already written %2B, so nothing else changes.
  url.search = search.toString().replaceAll("+", "%20");
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
    // policy timeout bounds the whole exchange, a replay included.
    return ctx.upstream(async (signal) => {
      const response = await send(signal);
      // The upstream refused the gateway's credentials, which a rotation may have replaced
      // since the secret was cached. The secret is read again from the store and every part
      // drops what it holds, so the next request authenticates afresh. A GET is sent once more,
      // inside the same attempt, so the timeout bounds both and only the second answer is the
      // call's, to be mapped and counted: the refusal the replay answered is not an upstream
      // failure. Once: a second refusal is the upstream's answer. Any other method is not sent
      // again, since the upstream may have acted on it, and the refusal is its answer.
      if (deps.reauthenticate === undefined || !REFUSED.has(response.status)) {
        return response;
      }
      const replay = REPLAYED.has(call.method);
      ctx.log.info(
        replay
          ? "The upstream refused the gateway's credentials; the secret is read again and the request sent once more"
          : "The upstream refused the gateway's credentials; the secret is read again for the next request, and this one is not sent again",
        { status: response.status },
      );
      await deps.reauthenticate();
      return replay ? send(signal) : response;
    });

    async function send(signal: AbortSignal): Promise<OpenApiRestResponse> {
      // Later layers override earlier ones: driver defaults, static headers, the call's own,
      // then authentication, which nothing before it may name anyway.
      const headers = new Headers({ accept: "application/json" });
      for (const [key, value] of deps.staticHeaders) headers.set(key, value);
      for (const [key, value] of callHeaders) headers.set(key, value);
      // Before authentication, so a scheme that signs the request signs the content type it is
      // sent with; and again after it, so nothing authentication returns replaces it.
      if (body !== undefined) headers.set("content-type", "application/json");
      const authentication = await deps.auth({
        operation: name,
        signal,
        method: call.method,
        url: new URL(url.href),
        headers: new Headers(headers),
        body,
      });
      for (const [key, value] of authentication) headers.set(key, value);
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
        // Read as the headers arrive, before the body and before the status is read as an
        // outcome or an error: a caller gets an upstream's id for a request it refused, and for
        // one whose body never finished arriving, as surely as for one it carried out.
        (responseHeaders) => {
          for (const [reported, value] of readMetadata(
            responseHeaders,
            deps.metadata,
          )) {
            ctx.meta(reported, value);
          }
        },
      );
    }
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
