import { isPlatformName } from "@repo/utils/is-platform-name";

// CloudFront hands the function the path as the caller sent it, still percent-encoded. Anything a
// router might read as a different path is refused here, before any later step reads it.
const UNSAFE = /%2f|%5c|%2e|\\/i;

// Routable paths are /app/<domain name>/...
export function isRoutable(uri: string): boolean {
  if (UNSAFE.test(uri)) return false;

  const segments = uri.split("/");
  if (segments[0] !== "" || segments[1] !== "app") return false;

  // The rule for names in the infra's config. Lambda@Edge checks the name is a domain that exists;
  // this only checks it could be one. It becomes part of an origin hostname, so it must never
  // carry a dot, a port or anything else.
  const domain = segments[2];
  if (domain === undefined || !isPlatformName(domain)) return false;

  // An index loop: the runtime has no for...of.
  for (let i = 3; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}
