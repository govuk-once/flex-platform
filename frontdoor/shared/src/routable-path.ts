import { isPlainPath } from "@repo/cloudfront-js-utils/is-plain-path";
import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";

// Routable paths are /app/<domain name>/..., but for the two a domain can never be asked for.
export function isRoutable(uri: string): boolean {
  if (!isPlainPath(uri)) return false;

  const segments = uri.split("/");
  if (segments[1] !== "app") return false;

  // The rule for names in the infra's config. Lambda@Edge checks the name is a domain that exists;
  // this only checks it could be one. It becomes part of an origin hostname, so it must never
  // carry a dot, a port or anything else.
  const domain = segments[2];
  if (domain === undefined || !isPlatformName(domain)) return false;

  // A domain sees what follows its name, from the root of its API's own domain name, where API
  // Gateway keeps /ping and /sping for its health check and answers them itself: no signature
  // checked, and the domain's code never run. Only as the whole of that path: under either, or
  // deeper, a path is the domain's as any other is.
  const only = segments.length === 4 ? segments[3] : undefined;
  return only !== "ping" && only !== "sping";
}
