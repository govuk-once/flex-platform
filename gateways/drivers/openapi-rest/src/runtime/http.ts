import { GatewayError } from "@repo/gateway-runtime";

import type { HttpMethod, OpenApiRestResponse } from "../types.ts";
import { describeTransportError } from "./diagnostics.ts";
import { parseJsonBody } from "./response.ts";

export interface SendDeps {
  readonly fetch: typeof fetch;
  readonly maxResponseBytes: number;
}

// A request ready to send: the URL resolved, the headers validated, the body serialised.
export interface OutgoingRequest {
  readonly method: HttpMethod;
  readonly url: URL;
  readonly headers: Headers;
  readonly body?: string;
}

// JSON.stringify's own errors can describe the value; replace them.
export function serialiseJson(body: unknown, where: string): string {
  try {
    const text = JSON.stringify(body);
    if (typeof text !== "string") {
      throw new TypeError("not serialisable");
    }
    return text;
  } catch {
    throw new GatewayError(
      "INTERNAL",
      `Request body cannot be serialised as JSON ${where}`,
    );
  }
}

// Buffers at most `limit` bytes and cancels the stream past that, so an oversized or endless
// body cannot exhaust memory while the timeout still has budget.
async function readBody(
  response: Response,
  limit: number,
  tooLarge: () => GatewayError,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Sends one request with the signal it is given and reads the whole body, so whatever bounds
// the caller bounds the exchange. Redirects are not followed. Every failure leaves as a
// GatewayError naming `where`, such as `for operation "x" (GET /x)`: a transport error is
// reduced to a recognised name and code, and an abort is reported as such, since the runtime
// treats anything thrown under an aborted signal as the timeout it was.
export async function sendRequest(
  deps: SendDeps,
  request: OutgoingRequest,
  signal: AbortSignal,
  where: string,
): Promise<OpenApiRestResponse> {
  let response: Response;
  let text: string;
  try {
    response = await deps.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal,
      redirect: "manual",
    });
    text = await readBody(
      response,
      deps.maxResponseBytes,
      () =>
        new GatewayError(
          "UPSTREAM_CONTRACT_VIOLATION",
          `Upstream response exceeded ${deps.maxResponseBytes} bytes ${where}`,
        ),
    );
  } catch (err: unknown) {
    if (err instanceof GatewayError) throw err;
    if (signal.aborted) {
      throw new GatewayError("INTERNAL", `Upstream attempt aborted ${where}`);
    }
    throw new GatewayError(
      "UPSTREAM_ERROR",
      `Upstream request failed ${where}: ${describeTransportError(err)}`,
    );
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: () => parseJsonBody(text, where),
  };
}
