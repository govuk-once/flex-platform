import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DomainConfig } from "../src/types.ts";
import { createTestClient, testCallerToken } from "../test/fixtures/test-client.ts";

const Echo = z.object({ caller: z.string(), body: z.unknown().optional() });

function echo({ caller, body }: { caller: object; body?: unknown }) {
  return {
    status: 200,
    body: { caller: JSON.stringify(caller), body },
  };
}

const domain: DomainConfig = {
  name: "domain-a",
  description: "A domain for tests",
  routes: {
    "GET /v1/echo": {
      handler: echo,
      description: "A route",
      responses: { 200: Echo },
    },
    "DELETE /v1/echo": {
      handler: echo,
      description: "A route",
      responses: { 200: Echo },
    },
    "POST /v1/echo": {
      description: "A route",
      handler: echo,
      body: z.strictObject({ title: z.string() }),
      responses: { 200: Echo },
    },
    "PUT /v1/echo": {
      description: "A route",
      handler: echo,
      body: z.strictObject({ title: z.string() }),
      responses: { 200: Echo },
    },
    "PATCH /v1/echo": {
      description: "A route",
      handler: echo,
      body: z.strictObject({ title: z.string() }),
      responses: { 200: Echo },
    },
  },
};

async function callerOf(response: Response): Promise<unknown> {
  const { caller } = Echo.parse(await response.json());

  return JSON.parse(caller);
}

describe("createTestClient", () => {
  it("sends each method, with a JSON body where one is given", async () => {
    const client = createTestClient(domain);

    expect((await client.get("/v1/echo")).status).toBe(200);
    expect((await client.delete("/v1/echo")).status).toBe(200);

    for (const send of [client.post, client.put, client.patch]) {
      const response = await send("/v1/echo", { title: "Renew" });

      expect(Echo.parse(await response.json()).body).toEqual({
        title: "Renew",
      });
    }
  });

  it("sends a caller token for the default caller, or the one it is given", async () => {
    expect(
      await callerOf(await createTestClient(domain).get("/v1/echo")),
    ).toEqual({
      pairwiseId: "test-user",
      pushId: "test-push-id",
    });
    expect(
      await callerOf(
        await createTestClient(domain, {
          caller: { pairwiseId: "user-a" },
        }).get("/v1/echo"),
      ),
    ).toEqual({ pairwiseId: "user-a", pushId: "test-push-id" });
  });

  it("adds the caller token to a request it is given whole, unless it has one", async () => {
    const client = createTestClient(domain);

    expect(
      await callerOf(
        await client.request(new Request("https://domain.invalid/v1/echo")),
      ),
    ).toEqual({ pairwiseId: "test-user", pushId: "test-push-id" });

    const own = testCallerToken({ pairwiseId: "user-b", pushId: "push-b" });

    expect(
      await callerOf(
        await client.request(
          new Request("https://domain.invalid/v1/echo", {
            headers: { "x-flex-secure": own },
          }),
        ),
      ),
    ).toEqual({ pairwiseId: "user-b", pushId: "push-b" });
  });

  it("writes no log line unless asked to", async () => {
    const lines: string[] = [];

    await createTestClient(domain).get("/v1/echo");
    await createTestClient(domain, { onLog: (line) => lines.push(line) }).get(
      "/v1/echo",
    );

    expect(lines).toHaveLength(1);
  });
});
