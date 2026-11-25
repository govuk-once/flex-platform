// A domain served on a local port, for a developer to call by hand. Each request runs through the
// same `serve` as the function. A request with no caller token is given a stand-in, as the
// Frontdoor would add one. `console` is left alone, so a developer can debug.

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { pinoSink } from "../src/runtime/log-writer.ts";
import { createServe } from "../src/runtime/serve.ts";
import { CALLER_TOKEN_HEADER } from "../src/http.ts";
import type { DomainConfig } from "../src/types.ts";
import { testCallerToken } from "../test/fixtures/test-client.ts";

// What Lambda gives a domain's function, which a local request is given too.
const REMAINING_TIME_MS = 29_000;

const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const LOCAL_CALLER_TOKEN = testCallerToken({
  pairwiseId: "local-user",
  pushId: "local-push-id",
});

async function requestFrom(
  incoming: IncomingMessage,
  origin: string,
): Promise<Request> {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of typeof value === "string" ? [value] : (value ?? [])) {
      headers.append(name, item);
    }
  }

  if (!headers.has(CALLER_TOKEN_HEADER)) {
    headers.set(CALLER_TOKEN_HEADER, LOCAL_CALLER_TOKEN);
  }

  const method = incoming.method ?? "GET";

  const chunks: Buffer[] = [];

  for await (const chunk of incoming) chunks.push(chunk as Buffer);

  return new Request(new URL(incoming.url ?? "/", origin), {
    method,
    headers,
    body: BODYLESS_METHODS.has(method) ? null : Buffer.concat(chunks),
  });
}

async function writeResponse(
  response: Response,
  outgoing: ServerResponse,
): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));

  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

/** Serves the domain on `port`, and answers with the listening server. */
export function serveLocally(domain: DomainConfig, port = 3000): Server {
  const serve = createServe(domain, { sink: pinoSink(domain.name) });

  const origin = `http://localhost:${port}`;

  const server = createServer((incoming, outgoing) => {
    void requestFrom(incoming, origin)
      .then((request) => serve(request, { remainingTimeMs: REMAINING_TIME_MS }))
      .then((response) => writeResponse(response, outgoing))
      .catch(() => {
        outgoing.writeHead(400).end();
      });
  });

  return server.listen(port);
}
