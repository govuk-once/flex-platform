import { UPSTREAM_TARGET_ENV } from "@repo/gateway-runtime";

// Cleartext http sends the gateway's credential, and every payload, over the network as written.
// Loopback is the exception: a local stub and a sidecar that terminates TLS are both reached
// there, and nothing leaves the host. Membership, not a pattern: "localhost.example.test" is a
// remote host that merely reads like one of these.
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

// Whether a URL may be reached without TLS. Callers raise their own failure, since the target is
// checked when the executor is created and an authentication address at request time.
export function isCleartextAllowed(url: URL): boolean {
  return url.protocol !== "http:" || LOOPBACK_HOSTNAMES.has(url.hostname);
}

// For this driver the shared upstream target is the base URL of the REST API. The path of the
// target, if any, prefixes every operation path. `source` names where it came from in a failure:
// the environment variable, or the secret field a configuration names, whose value is a secret's
// and so is never repeated, not even its scheme.
export function parseUpstreamTarget(
  value: string,
  source: string = UPSTREAM_TARGET_ENV,
): URL {
  const fromEnvironment = source === UPSTREAM_TARGET_ENV;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${source} must be an absolute http or https URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      fromEnvironment
        ? `${source} must use http or https, got "${url.protocol}"`
        : `${source} must use http or https`,
    );
  }
  if (!isCleartextAllowed(url)) {
    throw new TypeError(
      `${source} must use https; http is accepted only for a loopback host`,
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new TypeError(
      `${source} must not contain a query string or fragment`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`${source} must not embed credentials`);
  }

  return url;
}
