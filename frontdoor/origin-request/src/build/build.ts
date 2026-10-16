import { isPlatformName } from "@repo/utils/is-platform-name";
import { buildSync } from "esbuild";

import type { OriginRequestConfig } from "../function/types.ts";

const ENTRY = new URL("../function/entry.ts", import.meta.url).pathname;

// The bundle is CommonJS, deployed as `index.js` with the handler `index.handler`.
export const HANDLER = "index.handler";

// Synchronous, because CDK builds constructs synchronously. Returns the code of `index.js`, with
// every dependency bundled and the config baked in.
export function buildOriginRequestFunction(
  config: OriginRequestConfig,
): string {
  checkRoutes(config.routes);
  const result = buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node24",
    define: { ORIGIN_REQUEST_CONFIG: JSON.stringify(config) },
    // Not minified, so the source locations a failure logs point at a line worth reading.
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error("esbuild produced no output");
  return output;
}

// Lowercase labels, at least two, the last starting with a letter, so never a URL, a port or an IP
// address. The config holds hosts to DNS's limits.
const HOST = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;

// The routing map comes from config, so a bad one fails the build rather than a request.
function checkRoutes(routes: OriginRequestConfig["routes"]): void {
  for (const [domain, host] of Object.entries(routes)) {
    if (!isPlatformName(domain)) {
      throw new Error(
        `The route ${JSON.stringify(domain)} is not a domain name the CloudFront Function lets through`,
      );
    }
    if (!HOST.test(host)) {
      throw new Error(
        `The route for ${domain} goes to ${JSON.stringify(host)}, which is not a DNS name`,
      );
    }
  }
}
