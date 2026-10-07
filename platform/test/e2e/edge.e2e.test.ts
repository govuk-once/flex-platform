import { describe, expect, inject, it } from "vitest";

import { findWafLogEntry } from "./waf-logs.ts";

/** A Log4j JNDI lookup, which the known bad inputs rule group blocks in any field. */
const KNOWN_BAD_INPUT = "${jndi:ldap://127.0.0.1/a}";

const WAF_LOG_WAIT_MS = 5 * 60 * 1000;
const WAF_LOG_POLL_MS = 10 * 1000;

const { url, wafLogGroupName, validPath } = inject("edgeEnvironment");

describe("the edge", () => {
  it("blocks a request matching a known bad pattern at the edge and logs the block", async () => {
    const sentAt = new Date();
    const response = await fetch(`${url}${validPath}`, {
      headers: { "x-flex-edge-probe": KNOWN_BAD_INPUT },
      redirect: "manual",
    });

    expect(response.status).toBe(403);
    const requestId = response.headers.get("x-amz-cf-id");
    expect(requestId).toBeTruthy();
    expect(response.headers.get("x-cache")).toContain("cloudfront");
    expect(response.headers.get("server")).toBe("CloudFront");

    const entry = await findWafLogEntry(wafLogGroupName, requestId ?? "", {
      from: sentAt,
      waitMs: WAF_LOG_WAIT_MS,
      pollMs: WAF_LOG_POLL_MS,
    });
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      action: "BLOCK",
      terminatingRuleId: "AWSManagedRulesKnownBadInputsRuleSet",
    });
  });

  it("passes a well formed request to the API layer, which answers it", async () => {
    const response = await fetch(`${url}${validPath}`, { redirect: "manual" });

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("x-amz-cf-id")).toBeTruthy();
    expect(response.headers.get("via")).toContain("cloudfront");
  });

  it("insists on HTTPS and sets the security headers on what it returns", async () => {
    const response = await fetch(`${url}${validPath}`, { redirect: "manual" });

    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const insecure = await fetch(url.replace("https://", "http://"), {
      redirect: "manual",
    }).catch(() => undefined);
    // CloudFront answers a plain HTTP viewer with 403 when the behaviour is HTTPS only.
    expect(insecure?.status).toBe(403);
  });
});
