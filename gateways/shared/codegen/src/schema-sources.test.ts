import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SchemaSourceError, schemaSources } from "./schema-sources.ts";

let root: string;
let gatewayDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "schema-sources-"));
  gatewayDir = path.join(root, "gateway");
  await mkdir(gatewayDir);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("schemaSources, from the gateway's directory", () => {
  it("reads a path within it", async () => {
    await mkdir(path.join(gatewayDir, "specs"));
    await writeFile(path.join(gatewayDir, "specs", "api.json"), "{}");

    await expect(
      schemaSources(gatewayDir).load("specs/api.json"),
    ).resolves.toBe("{}");
  });

  it.each([
    ["one that climbs out of it", "../outside.json"],
    ["an absolute one", path.join(os.tmpdir(), "outside.json")],
  ])("refuses %s", async (_what, location) => {
    await writeFile(path.join(root, "outside.json"), "{}");
    await writeFile(path.join(os.tmpdir(), "outside.json"), "{}");
    try {
      await expect(schemaSources(gatewayDir).load(location)).rejects.toThrow(
        /: it is outside the gateway's directory/,
      );
    } finally {
      await rm(path.join(os.tmpdir(), "outside.json"), { force: true });
    }
  });

  it("refuses a link that leads out of it, by where it leads", async () => {
    await writeFile(path.join(root, "outside.json"), "{}");
    await symlink(
      path.join(root, "outside.json"),
      path.join(gatewayDir, "inside.json"),
    );

    await expect(schemaSources(gatewayDir).load("inside.json")).rejects.toThrow(
      SchemaSourceError,
    );
  });

  it("says so when there is no such file", async () => {
    await expect(
      schemaSources(gatewayDir).load("missing.json"),
    ).rejects.toThrow(/Cannot read "missing.json": there is no such file/);
  });
});

describe("schemaSources, from an address", () => {
  const answering = (response: Response) => {
    const fetching = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal("fetch", fetching);
    return fetching;
  };

  it("fetches over https, following no redirect and waiting only so long", async () => {
    const fetching = answering(new Response("openapi: 3.0.3"));

    await expect(
      schemaSources(gatewayDir).load("https://upstream.test/openapi.yml"),
    ).resolves.toBe("openapi: 3.0.3");

    const [url, options] = fetching.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe("https://upstream.test/openapi.yml");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    "http://upstream.test/openapi.yml",
    "file:///etc/passwd",
    "ftp://x.test/a",
  ])("refuses %s without fetching it", async (location) => {
    const fetching = answering(new Response(""));

    await expect(schemaSources(gatewayDir).load(location)).rejects.toThrow(
      `Cannot read "${location}": it is not an https address`,
    );
    expect(fetching).not.toHaveBeenCalled();
  });

  it("refuses an answer that is not a success, and one that failed to arrive", async () => {
    answering(new Response("gone", { status: 404 }));
    await expect(
      schemaSources(gatewayDir).load("https://upstream.test/a"),
    ).rejects.toThrow(/the server answered 404/);

    vi.stubGlobal("fetch", () => Promise.reject(new Error("socket hang up")));
    await expect(
      schemaSources(gatewayDir).load("https://upstream.test/a"),
    ).rejects.toThrow(/the request failed/);
  });

  it("refuses more than any description of an API holds, and bytes that are not text", async () => {
    answering(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    await expect(
      schemaSources(gatewayDir).load("https://upstream.test/a"),
    ).rejects.toThrow(/it is larger than/);

    answering(new Response(new Uint8Array([0xff, 0xfe, 0xfd])));
    await expect(
      schemaSources(gatewayDir).load("https://upstream.test/a"),
    ).rejects.toThrow();
  });

  it("stops reading at the limit rather than after it", async () => {
    // The limit bounds what is held, not what a host sends: a body taken whole and measured
    // after would let one answering with gigabytes spend them all first. Chunks are handed over
    // as they are asked for, and this counts how many a run asks for before it gives up.
    const CHUNK = 1024 * 1024;
    const limit = 16 * 1024 * 1024;
    // Ends, so that a run which drains it says so rather than running until the machine does.
    const sends = 40;
    let delivered = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered >= sends * CHUNK) {
          controller.close();
          return;
        }
        delivered += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        cancelled = true;
      },
    });
    answering(new Response(body));

    await expect(
      schemaSources(gatewayDir).load("https://upstream.test/a"),
    ).rejects.toThrow(/it is larger than/);

    // What it takes to know, and not the rest: a stream reads one chunk ahead of what is asked
    // for, so the limit and two of them is the whole of what a run holds.
    expect(delivered).toBeLessThanOrEqual(limit + 2 * CHUNK);
    expect(cancelled).toBe(true);
  });
});
