import { isPlainPath } from "@repo/cloudfront-js-utils/is-plain-path";
import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";

// Routable paths are /app/<domain name>/...
export function isRoutable(uri: string): boolean {
  if (!isPlainPath(uri)) return false;

  const segments = uri.split("/");
  if (segments[1] !== "app") return false;

  // The rule for names in the infra's config. Lambda@Edge checks the name is a domain that exists;
  // this only checks it could be one. It becomes part of an origin hostname, so it must never
  // carry a dot, a port or anything else.
  const domain = segments[2];
  return domain !== undefined && isPlatformName(domain);
}
