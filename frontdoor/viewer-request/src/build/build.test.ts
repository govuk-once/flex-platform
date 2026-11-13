import type {
  CloudFrontResponse,
  ViewerRequestEvent,
} from "@repo/cloudfront-function";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFIG,
  ISSUER,
  token,
  viewerRequestEvent,
} from "../../test/helpers.ts";
import type { ViewerRequestConfig } from "../function/types.ts";
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
  return token({}, { exp: Math.floor(Date.now() / 1000) + 3600, ...payload });
}

describe("buildViewerRequestFunction", () => {
  it("produces a bundle within CloudFront's size limit and in the runtime's shape", () => {
    const code = buildViewerRequestFunction(CONFIG);

    // CloudFront refuses a function larger than 10 KB.
    expect(Buffer.byteLength(code)).toBeLessThanOrEqual(10 * 1024);
    expect(code).toContain("function handler(");
    expect(code).not.toMatch(/\bexport\b/);
  });

  it("runs, passing a valid request on under an ID", async () => {
    const handler = await load(buildViewerRequestFunction(CONFIG));
    const event = viewerRequestEvent({
      headers: { authorization: `Bearer ${liveToken()}` },
    });

    expect(handler(event)).toBe(event.request);
    expect(event.request.headers["x-correlation-id"]?.value).toMatch(
      /^1-[0-9a-f]{8}-[0-9a-f]{24}$/,
    );
  });

  it("bakes in the issuers it was built with", async () => {
    const config: ViewerRequestConfig = {
      ...CONFIG,
      issuers: [
        {
          issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_other",
          clientIds: ["other-client"],
        },
      ],
    };
    const handler = await load(buildViewerRequestFunction(config));
    const result = handler(
      viewerRequestEvent({
        headers: { authorization: `Bearer ${liveToken({ iss: ISSUER })}` },
      }),
    ) as CloudFrontResponse;

    expect(result.statusCode).toBe(401);
  });

  it("refuses to build a function larger than CloudFront allows", () => {
    const issuers = Array.from({ length: 200 }, (_, i) => ({
      issuer: `https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_pool${i}`,
      clientIds: [`client-${i}`],
    }));

    expect(() => buildViewerRequestFunction({ issuers })).toThrow(
      /The function is \d+ bytes; CloudFront allows 10240/,
    );
  });
});
