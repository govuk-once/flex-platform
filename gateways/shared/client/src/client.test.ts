import { describe, expect, expectTypeOf, it } from "vitest";

import {
  connect,
  GatewayInvocationError,
  type LambdaSettings,
} from "./client.ts";
import { withCallerContext } from "./context.ts";

// The shape a generated contract's `Operations` has.
interface Operations {
  readonly getUser: {
    readonly input: { readonly id: string };
    readonly result: {
      readonly outcome: "ok";
      readonly data: { readonly name: string };
    };
    readonly response:
      | { readonly ok: false; readonly error: { readonly code: string } }
      | {
          readonly ok: true;
          readonly outcome: "ok";
          readonly data: { readonly name: string };
        };
  };
}

interface Sent {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface Answer {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}

// The function the fixture's id names, through its one alias.
const FUNCTION = "gateway-sandbox-fixture:live";

// The SDK's HTTP layer replaced: each request is recorded, and answered in turn. With no answers,
// a request waits until its signal aborts it, as the SDK's own handler does.
function stubbed(...answers: Answer[]) {
  const sent: Sent[] = [];
  const requestHandler = {
    handle(
      request: {
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      },
      options?: { abortSignal?: AbortSignal },
    ) {
      sent.push({
        path: request.path,
        headers: request.headers,
        body:
          request.body instanceof Uint8Array
            ? JSON.parse(new TextDecoder().decode(request.body))
            : request.body,
      });
      const answer = answers[sent.length - 1] ?? answers.at(-1);
      if (answer === undefined) {
        return new Promise<never>((_, reject) => {
          options?.abortSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      const body =
        typeof answer.body === "string"
          ? new TextEncoder().encode(answer.body)
          : answer.body;
      return Promise.resolve({
        response: {
          statusCode: answer.statusCode,
          headers: { ...answer.headers },
          body,
        },
      });
    },
  };
  const settings: LambdaSettings = {
    region: "eu-west-2",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    requestHandler,
  };
  const client = connect<Operations>(
    "sandbox",
    "fixture",
    ["getUser"],
    settings,
  );
  return { client, sent };
}

const answered = (envelope: unknown, headers = {}): Answer => ({
  statusCode: 200,
  headers,
  body: JSON.stringify(envelope),
});

async function failure(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(GatewayInvocationError);
  return error as GatewayInvocationError;
}

describe("connect", () => {
  it("invokes the gateway's function once, synchronously, with the envelope", async () => {
    const { client, sent } = stubbed(
      answered({ ok: true, outcome: "ok", data: { name: "Ada" } }),
    );
    await client.getUser({ id: "u1" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(
      `/2015-03-31/functions/${encodeURIComponent(FUNCTION)}/invocations`,
    );
    expect(sent[0]?.headers["x-amz-invocation-type"]).toBe("RequestResponse");
    // The execution log's tail is never asked for.
    expect(sent[0]?.headers["x-amz-log-type"]).toBeUndefined();
    expect(sent[0]?.body).toEqual({
      operation: "getUser",
      input: { id: "u1" },
      secure: { values: {}, signature: "" },
    });
  });

  it("sends the secure values of its caller's context", async () => {
    const { client, sent } = stubbed(
      answered({ ok: true, outcome: "ok", data: { name: "Ada" } }),
    );
    const secure = { values: { sub: "u1" }, signature: "sig" };
    await withCallerContext({ deadline: Date.now() + 60_000, secure }, () =>
      // Reached after an await, as a handler's calls are.
      Promise.resolve().then(() => client.getUser({ id: "u1" })),
    );
    expect(sent[0]?.body).toMatchObject({ secure });
  });

  it("stops waiting at its caller's deadline", async () => {
    const { client, sent } = stubbed();
    const error = await failure(
      withCallerContext({ deadline: Date.now() + 50 }, () =>
        client.getUser({ id: "u1" }),
      ),
    );
    expect(error.reason).toBe("timed_out");
    expect(error.message).toBe(
      "The caller's deadline passed before the gateway answered",
    );
    expect(sent).toHaveLength(1);
  });

  it("sends nothing once its caller's deadline has passed", async () => {
    const { client, sent } = stubbed(
      answered({ ok: true, outcome: "ok", data: { name: "Ada" } }),
    );
    const error = await failure(
      withCallerContext({ deadline: Date.now() - 1 }, () =>
        client.getUser({ id: "u1" }),
      ),
    );
    expect(error.reason).toBe("timed_out");
    expect(sent).toHaveLength(0);
  });

  it("refuses a deadline that is not a time", () => {
    expect(() => withCallerContext({ deadline: Number.NaN }, () => 1)).toThrow(
      "A caller's deadline must be a finite number of milliseconds since the epoch.",
    );
  });

  it("returns a success as the gateway answered it", async () => {
    const { client } = stubbed(
      answered({
        ok: true,
        outcome: "ok",
        data: { name: "Ada" },
        meta: { requestId: "r1" },
      }),
    );
    await expect(client.getUser({ id: "u1" })).resolves.toEqual({
      ok: true,
      outcome: "ok",
      data: { name: "Ada" },
      meta: { requestId: "r1" },
    });
  });

  it("returns an error envelope rather than throwing it", async () => {
    const { client } = stubbed(
      answered({ ok: false, error: { code: "NOT_FOUND" } }),
    );
    await expect(client.getUser({ id: "u1" })).resolves.toEqual({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("keeps only an envelope's own fields", async () => {
    const { client } = stubbed(
      answered({
        ok: false,
        error: { code: "INTERNAL", message: "boom" },
        stack: "at handler",
      }),
    );
    await expect(client.getUser({ id: "u1" })).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL" },
    });
  });

  it("leaves out a meta value that is not a scalar", async () => {
    const { client } = stubbed(
      answered({
        ok: true,
        outcome: "ok",
        data: { name: "Ada" },
        meta: { requestId: "r1", nested: { a: 1 }, absent: null },
      }),
      answered({
        ok: true,
        outcome: "ok",
        data: { name: "Ada" },
        meta: ["r1"],
      }),
    );
    await expect(client.getUser({ id: "u1" })).resolves.toMatchObject({
      meta: { requestId: "r1" },
    });
    await expect(client.getUser({ id: "u1" })).resolves.not.toHaveProperty(
      "meta",
    );
  });

  it.each([
    ["is not JSON", "{"],
    ["is not UTF-8", new Uint8Array([0x22, 0xff, 0x22])],
    ["is not an object", "[]"],
    ["has no ok", JSON.stringify({ outcome: "ok", data: {} })],
    ["has no outcome", JSON.stringify({ ok: true, data: {} })],
    ["has no data", JSON.stringify({ ok: true, outcome: "ok" })],
    ["has no error", JSON.stringify({ ok: false })],
    [
      "has an unknown error code",
      JSON.stringify({ ok: false, error: { code: "TEAPOT" } }),
    ],
    [
      "has an inherited name as its code",
      JSON.stringify({ ok: false, error: { code: "toString" } }),
    ],
    ["is empty", ""],
  ])("refuses an answer that %s", async (_, body) => {
    const { client } = stubbed({ statusCode: 200, body });
    const error = await failure(client.getUser({ id: "u1" }));
    expect(error.reason).toBe("invalid_response");
  });

  it("reports a function error without its payload", async () => {
    const { client } = stubbed(
      answered(
        { errorType: "Sandbox.Timedout", errorMessage: "user u1 timed out" },
        { "x-amz-function-error": "Unhandled" },
      ),
    );
    const error = await failure(client.getUser({ id: "u1" }));
    expect(error.reason).toBe("function_error");
    expect(error.message).toBe("The gateway's function failed: Unhandled");
  });

  it.each([
    [429, "TooManyRequestsException"],
    [500, "ServiceException"],
    [502, "EC2UnexpectedException"],
  ])(
    "sends a call Lambda refuses with %i only once",
    async (statusCode, type) => {
      const { client, sent } = stubbed({
        statusCode,
        headers: {
          "content-type": "application/json",
          "x-amzn-errortype": type,
        },
        body: JSON.stringify({ Type: "Service", message: "for user u1" }),
      });
      const error = await failure(client.getUser({ id: "u1" }));
      expect(sent).toHaveLength(1);
      expect(error.reason).toBe("invoke_failed");
      expect(error.message).toBe(`The gateway could not be invoked: ${type}`);
    },
  );

  it("reports a call its signal stopped as abandoned, within a deadline too", async () => {
    const { client, sent } = stubbed();
    const controller = new AbortController();
    const call = withCallerContext({ deadline: Date.now() + 60_000 }, () =>
      client.getUser({ id: "u1" }, { signal: controller.signal }),
    );
    await expect.poll(() => sent).toHaveLength(1);
    controller.abort();
    const error = await failure(call);
    expect(error.reason).toBe("aborted");
    expect(sent).toHaveLength(1);
  });

  it("refuses an id that cannot name a gateway's function", () => {
    expect(() => connect("sandbox", "fixture:other", [])).toThrow(
      /The gateway id .* must be/,
    );
  });

  it("refuses an environment that cannot name a gateway's function", () => {
    expect(() => connect("Sandbox", "fixture", [])).toThrow(
      /The environment .* must be/,
    );
  });

  it("has a function for each operation, and nothing else", () => {
    const { client } = stubbed();
    expect(Object.keys(client)).toEqual(["getUser"]);
    // Not a promise, so a client can be returned from an async function.
    expect(client).not.toHaveProperty("then");
  });

  it("types each operation's function by the contract", () => {
    const { client } = stubbed();
    expectTypeOf(client.getUser).parameter(0).toEqualTypeOf<{
      readonly id: string;
    }>();
    expectTypeOf(client.getUser).returns.resolves.toEqualTypeOf<
      Operations["getUser"]["response"]
    >();

    // Only the contract's operations have a function, and every call goes through one.
    expectTypeOf(client).not.toHaveProperty("deleteUser");
    expectTypeOf(client).not.toHaveProperty("call");

    // Checked by the compiler, never run.
    const unsent = () =>
      // @ts-expect-error the input is the operation's
      client.getUser({ name: "Ada" });
    expect(unsent).toBeTypeOf("function");
  });
});
