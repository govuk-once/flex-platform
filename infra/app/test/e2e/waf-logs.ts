import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

export interface WafLogEntry {
  readonly action: string;
  readonly terminatingRuleId: string;
  readonly httpRequest: { readonly requestId: string };
}

// WAF writes a CloudFront web ACL's logs in us-east-1 and nowhere else.
const client = new CloudWatchLogsClient({ region: "us-east-1" });

/**
 * Waits for the web ACL's log entry for a request, found by the id CloudFront assigned it, which
 * the response carried as `x-amz-cf-id` and WAF writes as the request id.
 */
export async function findWafLogEntry(
  logGroupName: string,
  requestId: string,
  { from, waitMs, pollMs }: { from: Date; waitMs: number; pollMs: number },
): Promise<WafLogEntry | undefined> {
  const deadline = Date.now() + waitMs;
  // Allow for clock skew between here and the edge.
  const startTime = from.getTime() - 60 * 1000;

  while (Date.now() < deadline) {
    const { events } = await client.send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime,
        filterPattern: `{ $.httpRequest.requestId = "${requestId}" }`,
        limit: 1,
      }),
    );
    const message = events?.[0]?.message;
    if (message !== undefined) return JSON.parse(message) as WafLogEntry;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return undefined;
}
