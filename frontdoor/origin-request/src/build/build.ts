import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";
import { buildLambdaFunction } from "@repo/lambda-function/build";

import type { OriginRequestConfig } from "../function/types.ts";

const ENTRY = new URL("../function/entry.ts", import.meta.url).pathname;

export { HANDLER } from "@repo/lambda-function/build";

// Synchronous, because CDK builds constructs synchronously. Returns the code of `index.js`, with
// every dependency bundled and the config baked in.
export function buildOriginRequestFunction(
  config: OriginRequestConfig,
): string {
  checkRoutes(config.routes);
  return buildLambdaFunction({
    entry: ENTRY,
    define: { ORIGIN_REQUEST_CONFIG: config },
  });
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
