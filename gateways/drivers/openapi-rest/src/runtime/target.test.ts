import { describe, expect, it } from "vitest";

import { parseUpstreamTarget } from "./target.ts";

describe("parseUpstreamTarget", () => {
  it("accepts an https base URL", () => {
    expect(parseUpstreamTarget("https://api.test").href).toBe(
      "https://api.test/",
    );
  });

  it("keeps a path prefix", () => {
    expect(parseUpstreamTarget("https://api.test/prod/v2").pathname).toBe(
      "/prod/v2",
    );
  });

  // A local stub and a TLS-terminating sidecar are both reached over loopback, so those stay.
  it.each([
    "http://localhost:3000",
    "http://LOCALHOST",
    "http://127.0.0.1:1",
    "http://[::1]:8080",
  ])("accepts the loopback http target %j", (value) => {
    expect(parseUpstreamTarget(value).protocol).toBe("http:");
  });

  it.each([
    ["not a url", /absolute http or https URL/],
    ["/relative", /absolute http or https URL/],
    ["ftp://api.test", /must use http or https/],
    ["https://api.test/?x=1", /query string or fragment/],
    ["https://api.test/#top", /query string or fragment/],
    ["https://user:pw@api.test", /embed credentials/],
    // Cleartext to anywhere but this host would send the gateway's credential in the clear.
    ["http://api.test", /http is accepted only for a loopback host/],
    ["http://10.0.0.1", /http is accepted only for a loopback host/],
    ["http://127.0.0.2", /http is accepted only for a loopback host/],
    // Remote hosts that merely read like loopback, which a prefix check would have let through.
    ["http://localhost.evil.test", /http is accepted only for a loopback host/],
    ["http://127.0.0.1.evil.test", /http is accepted only for a loopback host/],
  ])("rejects %j", (value, message) => {
    expect(() => parseUpstreamTarget(value)).toThrowError(message);
  });
});
