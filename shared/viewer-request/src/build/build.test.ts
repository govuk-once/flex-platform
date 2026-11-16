import type {
  CloudFrontResponse,
  ViewerRequestEvent,
} from "@repo/cloudfront-function";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIENCE,
  CONFIG,
  pipelineHeaders,
  token,
  viewerRequestEvent,
} from "../../test/helpers.ts";
import { buildViewerRequestFunction } from "./build.ts";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Handler = (event: ViewerRequestEvent) => unknown;

// Loads the built code as a module: the bundle as CloudFront receives it, with the export it had
// removed put back so the test can call it. A data: URL needs no file, and a module loaded from
// one can still import built-ins such as crypto.
async function load(code: string): Promise<Handler> {
  const source = `${code}\nexport { handler };\n`;
  const module = (await import(
    `data:text/javascript,${encodeURIComponent(source)}`
  )) as { handler: Handler };
  return module.handler;
}

// Tokens for the built function, which reads the real clock.
function liveToken(payload: Record<string, unknown> = {}): string {
  return token({}, { exp: Math.floor(Date.now() / 1000) + 300, ...payload });
}

function eventWith(liveTokenValue: string): ViewerRequestEvent {
  return viewerRequestEvent({
    headers: pipelineHeaders({ "x-flex-ci-token": liveTokenValue }),
  });
}

describe("buildViewerRequestFunction", () => {
  it("produces a bundle within CloudFront's size limit and in the runtime's shape", () => {
    const code = buildViewerRequestFunction(CONFIG);

    // CloudFront refuses a function larger than 10 KB.
    expect(Buffer.byteLength(code)).toBeLessThanOrEqual(10 * 1024);
    expect(code).toContain("function handler(");
    expect(code).not.toMatch(/\bexport\b/);
  });

  it("runs, passing a pipeline's request on under an ID", async () => {
    const handler = await load(buildViewerRequestFunction(CONFIG));
    const event = eventWith(liveToken());

    expect(handler(event)).toBe(event.request);
    expect(event.request.headers["x-correlation-id"]?.value).toMatch(
      /^1-[0-9a-f]{8}-[0-9a-f]{24}$/,
    );
  });

  it("refuses a token that has expired by the real clock", async () => {
    const handler = await load(buildViewerRequestFunction(CONFIG));
    const result = handler(
      eventWith(liveToken({ exp: Math.floor(Date.now() / 1000) - 1 })),
    ) as CloudFrontResponse;

    expect(result.statusCode).toBe(401);
  });

  it("bakes in the issuer and the audience it was built with", async () => {
    const other = await load(
      buildViewerRequestFunction({
        issuer: "https://issuer.example",
        audience: "https://other.flex-shared.example/ci",
      }),
    );
    const ours = eventWith(liveToken());
    const theirs = eventWith(
      liveToken({
        iss: "https://issuer.example",
        aud: "https://other.flex-shared.example/ci",
      }),
    );

    expect((other(ours) as CloudFrontResponse).statusCode).toBe(401);
    expect(other(theirs)).toBe(theirs.request);

    const built = await load(buildViewerRequestFunction(CONFIG));
    expect(
      (
        built(
          eventWith(liveToken({ aud: `${AUDIENCE}/other` })),
        ) as CloudFrontResponse
      ).statusCode,
    ).toBe(401);
  });
});
