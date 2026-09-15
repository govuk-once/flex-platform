import type {
  OpenApiRestCall,
  OpenApiRestClient,
  OpenApiRestResponse,
} from "@repo/gateway-driver-openapi-rest";
import { describe, expect, it, vi } from "vitest";

import handler from "./get-identity-exchange.ts";

const CALL: OpenApiRestCall = {
  method: "GET",
  path: "/v1/identity/exchange",
  query: { subjectId: "s1" },
};

// Spies are kept separately from the client so assertions never read a method off the
// client object, which the client type declares as methods.
function stubClient(status: number, body: unknown) {
  const text = body === null ? "" : JSON.stringify(body);
  const response: OpenApiRestResponse = {
    status,
    headers: new Headers(),
    text,
    json: () => (text === "" ? null : (JSON.parse(text) as unknown)),
  };
  const spies = {
    prepare: vi.fn(() => CALL),
    request: vi.fn(() => Promise.resolve(response)),
    mapResponse: vi.fn(() => ({
      outcome: "ok" as const,
      data: response.json(),
    })),
    invoke: vi.fn(),
  };
  const client: OpenApiRestClient = spies;
  return { client, spies };
}

describe("getIdentityExchange handler", () => {
  it("declares its input on its type", () => {
    // Never called; only its body is typechecked.
    const misuse = (client: OpenApiRestClient) =>
      // @ts-expect-error the handler's input is { subjectId: string }
      handler(123, client);
    expect(misuse).toBeTypeOf("function");
  });

  it("sends the operation's prepared request once", async () => {
    const { client, spies } = stubClient(200, { linkedId: "l1" });
    await handler({ subjectId: "s1" }, client);
    expect(spies.prepare).toHaveBeenCalledWith({ subjectId: "s1" });
    expect(spies.request).toHaveBeenCalledTimes(1);
    expect(spies.request).toHaveBeenCalledWith(CALL);
    expect(spies.invoke).not.toHaveBeenCalled();
  });

  it("turns a 404 into the unlinked outcome", async () => {
    const { client, spies } = stubClient(404, null);
    await expect(handler({ subjectId: "s1" }, client)).resolves.toEqual({
      outcome: "unlinked",
      data: null,
    });
    expect(spies.mapResponse).not.toHaveBeenCalled();
  });

  it("maps every other response through the driver", async () => {
    const { client, spies } = stubClient(200, { linkedId: "l1" });
    await expect(handler({ subjectId: "s1" }, client)).resolves.toEqual({
      outcome: "ok",
      data: { linkedId: "l1" },
    });
    expect(spies.mapResponse).toHaveBeenCalledTimes(1);
  });
});
