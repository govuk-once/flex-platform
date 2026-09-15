import { GatewayError } from "@repo/gateway-runtime";
import { describe, expect, it } from "vitest";

import { fakeFetch, headerOf, json } from "../../test/helpers.ts";
import { createAuthTransport } from "./auth-transport.ts";

const TARGET = new URL("https://api.test/prod");

function transport(
  respond: Parameters<typeof fakeFetch>[0],
  maxResponseBytes = 1_048_576,
) {
  const ff = fakeFetch(respond);
  const t = createAuthTransport({
    fetch: ff.fetch,
    target: TARGET,
    maxResponseBytes,
  });
  const signal = new AbortController().signal;
  return { t, ff, signal };
}

describe("createAuthTransport", () => {
  it("allows a loopback token endpoint over http", async () => {
    const { t, ff, signal } = transport(() => json(200, { access_token: "t" }));
    await t.request(
      { method: "POST", url: "http://127.0.0.1:8080/token", json: {} },
      signal,
    );
    expect(ff.calls[0]?.url).toBe("http://127.0.0.1:8080/token");
  });

  it("sends to an absolute URL with the given signal and returns the raw response", async () => {
    const { t, ff, signal } = transport(() => json(401, { error: "denied" }));
    const response = await t.request(
      { method: "POST", url: "https://idp.test/token", json: { a: 1 } },
      signal,
    );
    expect(response.status).toBe(401);
    expect(response.json()).toEqual({ error: "denied" });
    const [req] = ff.calls;
    expect(req?.url).toBe("https://idp.test/token");
    expect(req?.init.method).toBe("POST");
    expect(req?.init.signal).toBe(signal);
    expect(req?.init.redirect).toBe("manual");
    expect(req?.init.body).toBe('{"a":1}');
    expect(headerOf(req!, "content-type")).toBe("application/json");
    expect(headerOf(req!, "accept")).toBe("application/json");
  });

  it("resolves a path against the upstream target", async () => {
    const { t, ff, signal } = transport(() => json(200, {}));
    await t.request({ method: "GET", url: "/oauth/token" }, signal);
    expect(ff.calls[0]?.url).toBe("https://api.test/prod/oauth/token");
    expect(ff.calls[0]?.init.body).toBeUndefined();
  });

  it("keeps a query string on a path and on an absolute URL", async () => {
    const { t, ff, signal } = transport(() => json(200, {}));
    await t.request(
      { method: "GET", url: "/oauth/token?scope=a+b&scope=c" },
      signal,
    );
    expect(ff.calls[0]?.url).toBe(
      "https://api.test/prod/oauth/token?scope=a+b&scope=c",
    );
    await t.request({ method: "GET", url: "https://idp.test/t?v=1" }, signal);
    expect(ff.calls[1]?.url).toBe("https://idp.test/t?v=1");
  });

  it("sends a form body url-encoded", async () => {
    const { t, ff, signal } = transport(() => json(200, {}));
    await t.request(
      {
        method: "POST",
        url: "https://idp.test/token",
        headers: { "X-Client": "gw" },
        form: { grant_type: "client_credentials", client_secret: "a b&c" },
      },
      signal,
    );
    const [req] = ff.calls;
    expect(req?.init.body).toBe(
      "grant_type=client_credentials&client_secret=a+b%26c",
    );
    expect(headerOf(req!, "content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headerOf(req!, "x-client")).toBe("gw");
  });

  it.each([
    [
      "a JSON and a form body together",
      { method: "POST", url: "/t", json: {}, form: {} },
      /JSON body or a form body, not both/,
    ],
    [
      "a GET with a body",
      { method: "GET", url: "/t", form: {} },
      /GET requests cannot carry a body/,
    ],
    [
      "an unsupported method",
      { method: "TRACE" as "GET", url: "/t" },
      /unsupported method "TRACE"/,
    ],
    [
      "a relative URL that is not a path",
      { method: "GET", url: "token?secret=SYNTHETIC" },
      /must be an absolute http or https URL or a path/,
    ],
    [
      "a non-http URL",
      { method: "GET", url: "ftp://idp.test/SYNTHETIC" },
      /must use http or https/,
    ],
    [
      "a URL embedding credentials",
      { method: "GET", url: "https://user:SYNTHETIC@idp.test/token" },
      /must not embed credentials/,
    ],
    // A token exchange posts the credentials that obtain the credential.
    [
      "a cleartext URL to a remote host",
      { method: "POST", url: "http://idp.test/token" },
      /http is accepted only for a loopback host/,
    ],
    [
      "a cleartext URL to a host that reads like loopback",
      { method: "POST", url: "http://localhost.evil.test/token" },
      /http is accepted only for a loopback host/,
    ],
    [
      "a reserved header",
      { method: "GET", url: "/t", headers: { host: "x" } },
      /Authentication request headers: header "host" is set by the driver/,
    ],
  ] as const)("rejects %s without sending", async (_label, call, message) => {
    const { t, ff, signal } = transport(() => json(200, {}));
    const err = await t.request(call, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("INTERNAL");
    expect((err as GatewayError).message).toMatch(message);
    expect((err as GatewayError).message).not.toContain("SYNTHETIC");
    expect(ff.calls).toHaveLength(0);
  });

  it("maps a transport failure to UPSTREAM_ERROR naming the request kind only", async () => {
    const { t, signal } = transport(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    await expect(
      t.request({ method: "GET", url: "https://idp.test/SYNTHETIC" }, signal),
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message:
        "Upstream request failed for an authentication request: TypeError (ECONNREFUSED)",
    });
  });

  it("applies the response limit and the JSON check", async () => {
    const { t, signal } = transport(
      () => new Response("x".repeat(64), { status: 200 }),
      16,
    );
    await expect(
      t.request({ method: "GET", url: "/t" }, signal),
    ).rejects.toMatchObject({
      code: "UPSTREAM_CONTRACT_VIOLATION",
      message:
        "Upstream response exceeded 16 bytes for an authentication request",
    });

    const { t: html, signal: s2 } = transport(
      () => new Response("<html>", { status: 200 }),
    );
    const response = await html.request({ method: "GET", url: "/t" }, s2);
    expect(() => response.json()).toThrowError(
      "Upstream response body is not JSON for an authentication request",
    );
  });

  it("reports an aborted attempt as such", async () => {
    const controller = new AbortController();
    controller.abort();
    const { t } = transport((req) => {
      (req.init.signal as AbortSignal).throwIfAborted();
      return json(200, {});
    });
    await expect(
      t.request({ method: "GET", url: "/t" }, controller.signal),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Upstream attempt aborted for an authentication request",
    });
  });
});
