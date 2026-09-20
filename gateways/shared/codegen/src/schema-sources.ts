import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { SchemaSources } from "@repo/gateway-config";

// Where an upstream's description of itself is read from, for the one command that reads one.
// It is the only thing in this package that reaches the network, and deriving reaches it
// through nothing else, so what may be fetched, for how long and how much of it is decided here.

// Longer than any document takes and short enough that a run does not hang on a host that
// accepted the connection and then said nothing.
const TIMEOUT_MS = 30_000;
// Far larger than any API's description of itself; what arrives is parsed, so it is bounded.
const MAX_BYTES = 16 * 1024 * 1024;

export class SchemaSourceError extends Error {
  constructor(location: string, problem: string, options?: ErrorOptions) {
    super(`Cannot read "${location}": ${problem}`, options);
    this.name = "SchemaSourceError";
  }
}

async function fetched(location: string, url: URL): Promise<string> {
  let response: Response;
  try {
    // Redirects are refused rather than followed: a description is reviewed as coming from the
    // address the configuration names, and one that moved is for the configuration to follow.
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new SchemaSourceError(location, "the request failed", { cause });
  }
  if (!response.ok) {
    throw new SchemaSourceError(
      location,
      `the server answered ${String(response.status)}`,
    );
  }
  if (response.body === null) {
    throw new SchemaSourceError(location, "the response carried no document");
  }

  // Read as it arrives and counted as it is read, so the limit bounds what is held rather than
  // what is sent: taking the whole body first and measuring it after would let a host that
  // answers with gigabytes spend them all before anything here objected. Cancelled at the
  // limit, which closes the connection rather than draining the rest of it.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > MAX_BYTES) {
        throw new SchemaSourceError(
          location,
          `it is larger than ${String(MAX_BYTES)} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Whatever left the loop, nothing more is wanted. A reader already at its end cancels to
    // no effect, and a cancellation that itself fails says nothing about the document.
    await reader.cancel().catch(() => undefined);
  }

  const document = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    document.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(document);
}

async function fromGateway(
  location: string,
  gatewayDir: string,
): Promise<string> {
  const root = await realpath(gatewayDir);
  let file: string;
  try {
    file = await realpath(path.resolve(root, location));
  } catch (cause) {
    throw new SchemaSourceError(location, "there is no such file", { cause });
  }
  // Resolved through any link first, so a path is within the gateway by where it leads.
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new SchemaSourceError(
      location,
      "it is outside the gateway's directory, which is the only place a path is read from",
    );
  }
  return readFile(file, "utf-8");
}

export function schemaSources(gatewayDir: string): SchemaSources {
  return {
    async load(location) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(location)) {
        let url: URL;
        try {
          url = new URL(location);
        } catch (cause) {
          throw new SchemaSourceError(location, "it is not a URL", { cause });
        }
        if (url.protocol !== "https:") {
          throw new SchemaSourceError(
            location,
            "it is not an https address; a description is fetched over https or read from the gateway's directory",
          );
        }
        return fetched(location, url);
      }
      return fromGateway(location, gatewayDir);
    },
  };
}
