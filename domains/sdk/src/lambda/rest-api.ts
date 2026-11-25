// A domain's function: API Gateway's REST API proxy event, payload format 1.0, turned into a
// `Request` for `serve`, and the `Response` turned back.
//
// The path is built into a URL one segment at a time, each encoded, never by joining the event's
// path into a URL string. `URL` removes `.` and `..` segments, turns `\` into `/` and would read a
// `?` or `#` as the start of a query or fragment, so a path taken as it is could reach a route it
// does not name. A `.` or `..` segment cannot be written into a URL at all, even encoded, so a
// path with one is sent as `/`, which no route matches. The Frontdoor refuses all of these first.

import { replaceConsole } from "../runtime/console.ts";
import { pinoSink } from "../runtime/log-writer.ts";
import { refusalResponse } from "../runtime/responses.ts";
import { createServe } from "../runtime/serve.ts";
import type { DomainConfig } from "../types.ts";

export interface ProxyEvent {
  readonly httpMethod: string;
  readonly path: string;
  readonly multiValueHeaders?: Readonly<
    Record<string, readonly string[] | undefined>
  > | null;
  readonly multiValueQueryStringParameters?: Readonly<
    Record<string, readonly string[] | undefined>
  > | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

export interface ProxyResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: false;
}

const ORIGIN = "https://domain.invalid";

const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

function urlFrom({ path, multiValueQueryStringParameters }: ProxyEvent): URL {
  const segments = path.split("/");

  const unwritable = segments.some(
    (segment) => segment === "." || segment === "..",
  );

  const url = new URL(
    unwritable ? "/" : segments.map(encodeURIComponent).join("/"),
    ORIGIN,
  );

  for (const [name, values = []] of Object.entries(
    multiValueQueryStringParameters ?? {},
  )) {
    for (const value of values) url.searchParams.append(name, value);
  }

  return url;
}

/** The event as a `Request`. Throws for a header value a `Request` cannot hold. */
export function requestFrom(event: ProxyEvent): Request {
  const { httpMethod, multiValueHeaders, body, isBase64Encoded } = event;

  const headers = new Headers();

  for (const [name, values = []] of Object.entries(multiValueHeaders ?? {})) {
    for (const value of values) headers.append(name, value);
  }

  const sent =
    BODYLESS_METHODS.has(httpMethod) || body === undefined || body === null
      ? null
      : isBase64Encoded === true
        ? Buffer.from(body, "base64")
        : body;

  return new Request(urlFrom(event), {
    method: httpMethod,
    headers,
    body: sent,
  });
}

export async function resultFrom(response: Response): Promise<ProxyResult> {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
    isBase64Encoded: false,
  };
}

/**
 * The function's handler: `export const handler = createLambdaHandler(domain)`. The routes are
 * compiled when it is called, as the function loads, and `console`'s output is dropped from then
 * on.
 */
export function createLambdaHandler(
  domain: DomainConfig,
): (event: ProxyEvent, context: LambdaContext) => Promise<ProxyResult> {
  const sink = pinoSink(domain.name);

  replaceConsole(sink);

  const serve = createServe(domain, { sink });

  return async (event, context) => {
    let request: Request;

    try {
      request = requestFrom(event);
    } catch {
      sink.write("warn", "request could not be read", { status: 400 });

      return resultFrom(refusalResponse(400));
    }

    return resultFrom(
      await serve(request, {
        remainingTimeMs: context.getRemainingTimeInMillis(),
      }),
    );
  };
}
