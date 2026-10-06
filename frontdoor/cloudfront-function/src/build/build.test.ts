import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFIG,
  ISSUER,
  token,
  viewerRequestEvent,
} from "../../test/helpers.ts";
import type {
  CloudFrontResponse,
  ViewerRequestConfig,
  ViewerRequestEvent,
} from "../function/types.ts";
import { buildViewerRequestFunction, toRuntimeCode } from "./build.ts";

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

  it("runs, passing a valid request on under a trace", async () => {
    const handler = await load(buildViewerRequestFunction(CONFIG));
    const event = viewerRequestEvent({
      headers: { authorization: `Bearer ${liveToken()}` },
    });

    expect(handler(event)).toBe(event.request);
    expect(event.request.headers["x-amzn-trace-id"]?.value).toMatch(
      /^Root=1-[0-9a-f]{8}-[0-9a-f]{24}$/,
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
      /The viewer request function is \d+ bytes; CloudFront allows 10240/,
    );
  });
});

describe("toRuntimeCode", () => {
  it("removes the export, leaving the handler at the top level", () => {
    expect(
      toRuntimeCode(
        "var a=1;function handler(event){return a}export{handler};\n",
      ),
    ).toBe("var a=1;function handler(event){return a}");
  });

  it("accepts an async handler", () => {
    expect(
      toRuntimeCode(
        "async function handler(event){return event}export{handler};",
      ),
    ).toBe("async function handler(event){return event}");
  });

  // What esbuild emits for `export const handler = (event) => event`.
  it("refuses an arrow-function handler", () => {
    expect(() =>
      toRuntimeCode("const handler=event=>event;export{handler};\n"),
    ).toThrow("The bundle doesn't declare `function handler(`");
  });

  it("refuses a bundle that doesn't export handler", () => {
    expect(() =>
      toRuntimeCode("function handler(event){return event}"),
    ).toThrow("The bundle doesn't end by exporting handler");
  });

  it.each([
    [
      "only inside another function",
      "var x=function(){function handler(e){}};export{handler};",
    ],
    [
      "inside another function after a var",
      "var x=function(){var a=1;function handler(e){}};export{handler};",
    ],
    [
      "as a variable merged into another declaration",
      "const a=1,handler=e=>e;export{handler};",
    ],
    [
      "as a function expression",
      "var handler=function(e){return e};export{handler};",
    ],
    ["as a class", "class handler{};export{handler};"],
  ])("refuses a handler declared %s", (_, output) => {
    expect(() => toRuntimeCode(output)).toThrow(
      "The bundle doesn't declare `function handler(`",
    );
  });
});
