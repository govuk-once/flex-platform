import { isPlainPath } from "@repo/cloudfront-js-utils/is-plain-path";

// Everything a pipeline calls is under this.
const CI_PREFIX = "/ci/";

// Whether a path is one the pipeline API could serve: under `/ci/`, with nothing a router might
// read as a different path. Which paths it does serve is for the origin, which holds the routes.
export function isCiPath(uri: string): boolean {
  return uri.startsWith(CI_PREFIX) && isPlainPath(uri);
}
