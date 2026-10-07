import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

export interface WafLogEntry {
  readonly action: string;
  readonly terminatingRuleId: string;
  readonly terminatingRuleType?: string;
  readonly httpRequest: { readonly requestId: string };
}

const client = new CloudWatchLogsClient({ region: "us-east-1" });

export async function findWafLogEntry(
  logGroupName: string,
  requestId: string,
  { from, waitMs, pollMs }: { from: Date; waitMs: number; pollMs: number },
): Promise<WafLogEntry | undefined> {
  const deadline = Date.now() + waitMs;
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
    if (message !== undefined) {
      return JSON.parse(message) as WafLogEntry;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return undefined;
}
