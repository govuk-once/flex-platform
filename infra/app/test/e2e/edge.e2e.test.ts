import { describe, expect, inject, it } from "vitest";

import { findWafLogEntry } from "./waf-logs.ts";

/** A Log4j JNDI lookup, which the known bad inputs rule group blocks in any field. */
const KNOWN_BAD_INPUT = "${jndi:ldap://127.0.0.1/a}";

const WAF_LOG_WAIT_MS = 5 * 60 * 1000;
const WAF_LOG_POLL_MS = 10 * 1000;

// The path is any; no domain answers yet, and nothing here reaches one. Tests of a request that
// does come with the first domain.
const PATH = "/app/hello/health";

const { url, wafLogGroupName } = inject("edgeEnvironment");

describe("the edge", () => {
  it("blocks a request matching a known bad pattern and logs the block", async () => {
    const sentAt = new Date();
    const response = await fetch(`${url}${PATH}`, {
      headers: { "x-flex-edge-probe": KNOWN_BAD_INPUT },
      redirect: "manual",
    });

    // WAF answers before the CloudFront Function or the origin see the request.
    expect(response.status).toBe(403);
    const requestId = response.headers.get("x-amz-cf-id");
    expect(requestId).toBeTruthy();
    expect(response.headers.get("server")).toBe("CloudFront");

    const entry = await findWafLogEntry(wafLogGroupName, requestId ?? "", {
      from: sentAt,
      waitMs: WAF_LOG_WAIT_MS,
      pollMs: WAF_LOG_POLL_MS,
    });
    expect(entry).toMatchObject({
      action: "BLOCK",
      terminatingRuleId: "AWSManagedRulesKnownBadInputsRuleSet",
    });
  });

  it("turns away a request with no token at the CloudFront Function", async () => {
    const response = await fetch(`${url}${PATH}`, { redirect: "manual" });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-rejected-by")).toBe("cloudfront-function");
    expect(response.headers.get("x-correlation-id")).toMatch(
      /^1-[0-9a-f]{8}-[0-9a-f]{24}$/,
    );
  });

  it("refuses plain HTTP", async () => {
    const insecure = await fetch(url.replace("https://", "http://"), {
      redirect: "manual",
    }).catch(() => undefined);

    // CloudFront answers a plain HTTP viewer with 403 when the behaviour is HTTPS only.
    expect(insecure?.status).toBe(403);
  });
});
