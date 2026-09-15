import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallSiteLocation } from "./errors.ts";
import {
  describeUnexpectedError,
  GatewayError,
  selectFrameLocations,
} from "./errors.ts";

const execFile = promisify(execFileCb);

describe("GatewayError", () => {
  it("carries code and message", () => {
    const err = new GatewayError("INVALID_INPUT", "bad input");
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toBe("bad input");
    expect(err.name).toBe("GatewayError");
  });

  it("is an Error", () => {
    const err = new GatewayError("INTERNAL", "boom");
    expect(err).toBeInstanceOf(Error);
  });
});

// Every test below runs in this file's worker alone, so the formatter it installs on Error is
// not seen by another test at the same time.
const ORIGINAL_FORMATTER = Object.getOwnPropertyDescriptor(
  Error,
  "prepareStackTrace",
);

// Read through the descriptor: @types/node declares prepareStackTrace as a method, which
// must not be read unbound.
function formatterDescriptor(): Record<string, unknown> | undefined {
  return Object.getOwnPropertyDescriptor(Error, "prepareStackTrace") as
    Record<string, unknown> | undefined;
}

function installFormatter(
  value: unknown,
  flags: Pick<
    PropertyDescriptor,
    "writable" | "enumerable" | "configurable"
  > = {
    writable: true,
    enumerable: false,
    configurable: true,
  },
): void {
  Object.defineProperty(Error, "prepareStackTrace", { value, ...flags });
}

// Reads the name and message the way Node's default formatter does, so a throwing getter on
// either fails the formatting.
function defaultLikeFormatter(error: Error, callSites: unknown[]): string {
  return `${error.name}: ${error.message}\n    at ${String(callSites.length)}`;
}

afterEach(() => {
  if (ORIGINAL_FORMATTER === undefined) {
    Reflect.deleteProperty(Error, "prepareStackTrace");
  } else {
    Object.defineProperty(Error, "prepareStackTrace", ORIGINAL_FORMATTER);
  }
});

// Runs a script in a fresh Node process, outside Vitest's formatter and module runner, and
// parses the JSON it prints. The script receives describeUnexpectedError.
async function runInNode(body: string): Promise<unknown> {
  const errorsModule = new URL("./errors.ts", import.meta.url).href;
  const { stdout } = await execFile(process.execPath, [
    "--input-type=module",
    "-e",
    `import { describeUnexpectedError } from ${JSON.stringify(errorsModule)};\n${body}`,
  ]);
  return JSON.parse(stdout) as unknown;
}

describe("describeUnexpectedError", () => {
  it("locates a fresh native error at its source", () => {
    const summary = describeUnexpectedError(new TypeError("value=SYNTHETIC"));
    expect(Object.keys(summary)).toEqual(["frames"]);
    expect(summary.frames[0]).toMatch(/^at \/.*\/errors\.test\.ts:\d+:\d+$/);
    expect(JSON.stringify(summary)).not.toContain("SYNTHETIC");
  });

  it("keeps a multiline message with fake frames out of the output", () => {
    const shaped = new Error("failed\n    at SYNTHETIC_SECRET (/x.ts:1:1)");
    const summary = describeUnexpectedError(shaped);
    expect(summary.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain("SYNTHETIC");
  });

  it("copies neither the name, the properties nor the cause", () => {
    const named = Object.assign(new Error("x"), {
      name: "SYNTHETIC_NAME",
      request: { authorization: "SYNTHETIC_PROPERTY" },
      cause: new Error("SYNTHETIC_CAUSE"),
    });
    const summary = describeUnexpectedError(named);
    expect(summary.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain("SYNTHETIC");
  });

  it("omits function names", () => {
    function SYNTHETIC_FUNCTION(): Error {
      return new Error("x");
    }
    const summary = describeUnexpectedError(SYNTHETIC_FUNCTION());
    expect(summary.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain("SYNTHETIC");
  });

  it("yields no frames for a stack already formatted", () => {
    const formatted = new Error("x");
    void formatted.stack;
    expect(describeUnexpectedError(formatted)).toEqual({ frames: [] });
  });

  it("yields no frames for a rewritten stack, string or array", () => {
    const text = new Error("x");
    text.stack = "Error: x\n    at handler (/srv/gateway/handler.js:10:5)";
    expect(describeUnexpectedError(text)).toEqual({ frames: [] });

    const array = new Error("x");
    Object.defineProperty(array, "stack", {
      value: ["at /srv/gateway/handler.js:10:5"],
    });
    expect(describeUnexpectedError(array)).toEqual({ frames: [] });
  });

  it("cannot expose an old message once the stack was formatted", () => {
    const changed = new Error("SYNTHETIC_OLD");
    void changed.stack;
    changed.message = "replaced";
    const summary = describeUnexpectedError(changed);
    expect(summary).toEqual({ frames: [] });
    expect(JSON.stringify(summary)).not.toContain("SYNTHETIC");
  });

  it("survives a throwing stack getter and leaves the formatter as it was", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("SYNTHETIC_GETTER");
      },
    });
    expect(describeUnexpectedError(hostile)).toEqual({ frames: [] });
    expect(formatterDescriptor()).toEqual(ORIGINAL_FORMATTER);
  });

  it("survives a throwing name getter", () => {
    installFormatter(defaultLikeFormatter);
    const hostile = new Error("x");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("SYNTHETIC_GETTER");
      },
    });
    expect(describeUnexpectedError(hostile)).toEqual({ frames: [] });
    expect(formatterDescriptor()?.value).toBe(defaultLikeFormatter);
  });

  it("survives a throwing message getter", () => {
    installFormatter(defaultLikeFormatter);
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("SYNTHETIC_GETTER");
      },
    });
    expect(describeUnexpectedError(hostile)).toEqual({ frames: [] });
    expect(formatterDescriptor()?.value).toBe(defaultLikeFormatter);
  });

  it("survives a throwing formatter and restores it", () => {
    const throwing = (): never => {
      throw new Error("SYNTHETIC_FORMATTER");
    };
    installFormatter(throwing);
    expect(describeUnexpectedError(new Error("x"))).toEqual({ frames: [] });
    expect(formatterDescriptor()?.value).toBe(throwing);
  });

  it("delegates to the previous formatter, keeps its result and restores it", () => {
    const previous = vi.fn(
      (_error: unknown, _callSites: unknown) => "SYNTHETIC_FORMATTED",
    );
    installFormatter(previous);
    const err = new Error("x");
    const summary = describeUnexpectedError(err);

    expect(summary.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain("SYNTHETIC");
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous.mock.calls[0]?.[0]).toBe(err);
    expect(Array.isArray(previous.mock.calls[0]?.[1])).toBe(true);
    expect(err.stack).toBe("SYNTHETIC_FORMATTED");
    expect(formatterDescriptor()?.value).toBe(previous);
  });

  it.each([
    { writable: true, enumerable: true, configurable: true },
    { writable: false, enumerable: false, configurable: true },
  ])("restores the descriptor exactly, flags %j included", (flags) => {
    const formatter = vi.fn(() => "formatted");
    installFormatter(formatter, flags);
    expect(
      describeUnexpectedError(new Error("x")).frames.length,
    ).toBeGreaterThan(0);
    expect(formatterDescriptor()).toEqual({ value: formatter, ...flags });

    const throwing = (): never => {
      throw new Error("SYNTHETIC_FORMATTER");
    };
    installFormatter(throwing, flags);
    expect(describeUnexpectedError(new Error("x"))).toEqual({ frames: [] });
    expect(formatterDescriptor()).toEqual({ value: throwing, ...flags });
  });

  it("ignores hook invocations for other errors", () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const other = new Error("other"); // Captured with no frames at all.
    Error.stackTraceLimit = limit;

    const target = new Error("x");
    const native = Object.getOwnPropertyDescriptor(target, "stack");
    // Formatting the target formats the other error first, so the hook sees that one first.
    Object.defineProperty(target, "stack", {
      configurable: true,
      get: () => {
        void other.stack;
        return native?.get?.call(target) as unknown;
      },
    });

    const { frames } = describeUnexpectedError(target);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatch(/errors\.test\.ts:\d+:\d+$/);
  });

  it("leaves a missing formatter alone and yields no frames", () => {
    Reflect.deleteProperty(Error, "prepareStackTrace");
    expect(describeUnexpectedError(new Error("x"))).toEqual({ frames: [] });
    expect(formatterDescriptor()).toBeUndefined();
  });

  it("leaves an unusable formatter alone and yields no frames", () => {
    const get = (): undefined => undefined;
    Object.defineProperty(Error, "prepareStackTrace", {
      configurable: true,
      get,
    });
    expect(describeUnexpectedError(new Error("x"))).toEqual({ frames: [] });
    expect(formatterDescriptor()?.get).toBe(get);

    installFormatter(42);
    expect(describeUnexpectedError(new Error("x"))).toEqual({ frames: [] });
    expect(formatterDescriptor()?.value).toBe(42);
  });

  // Freezing the formatter cannot be undone in a process, so this runs in its own.
  it("leaves a frozen formatter alone and yields no frames", async () => {
    const result = await runInNode(`
      const frozen = () => "frozen";
      Object.defineProperty(Error, "prepareStackTrace", {
        value: frozen, writable: false, enumerable: false, configurable: false,
      });
      const summary = describeUnexpectedError(new Error("x"));
      const after = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
      console.log(JSON.stringify({
        summary, same: after.value === frozen, writable: after.writable, configurable: after.configurable,
      }));
    `);
    expect(result).toEqual({
      summary: { frames: [] },
      same: true,
      writable: false,
      configurable: false,
    });
  });

  // Vitest installs its own formatter; plain Node delegates to Node's default one.
  it("extracts locations under plain Node with its default formatter", async () => {
    const result = (await runInNode(`
      function site() {
        return Object.assign(new TypeError("value=SYNTHETIC\\n    at SYNTHETIC_FRAME (/x.js:1:1)"), {
          name: "SYNTHETIC_NAME",
          request: { authorization: "SYNTHETIC_PROPERTY" },
          cause: new Error("SYNTHETIC_CAUSE"),
        });
      }
      const err = site();
      const summary = describeUnexpectedError(err);
      console.log(JSON.stringify({
        summary,
        formatter: Error.prepareStackTrace.name,
        stackHead: String(err.stack).split("\\n")[0],
      }));
    `)) as {
      summary: { frames: string[] };
      formatter: string;
      stackHead: string;
    };

    expect(result.summary.frames[0]).toMatch(
      /^at file:\/\/\/.*\/\[eval\d*\]:\d+:\d+$/,
    );
    expect(result.summary.frames.length).toBeGreaterThan(1);
    expect(JSON.stringify(result.summary)).not.toContain("SYNTHETIC");
    expect(result.formatter).not.toBe("hook");
    expect(result.stackHead).toBe("SYNTHETIC_NAME: value=SYNTHETIC");
  });

  it("drops the frame of code created at runtime", () => {
    const evaluated = eval("new Error('x')") as Error;
    const { frames } = describeUnexpectedError(evaluated);
    expect(frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(frames)).not.toMatch(/eval|anonymous/);
  });

  it("describes a non-error value with no frames", () => {
    expect(describeUnexpectedError("SYNTHETIC")).toEqual({ frames: [] });
    expect(describeUnexpectedError(undefined)).toEqual({ frames: [] });
    expect(describeUnexpectedError({ stack: "at /x.js:1:1" })).toEqual({
      frames: [],
    });
  });
});

describe("selectFrameLocations", () => {
  // The casts let a test hand the selector what V8 never should, to show it is checked anyway.
  function site(
    filename: unknown,
    line: unknown = 1,
    column: unknown = 1,
    isEval = false,
  ): CallSiteLocation {
    return {
      isEval: () => isEval,
      getFileName: () => filename as string | null,
      getLineNumber: () => line as number | null,
      getColumnNumber: () => column as number | null,
    };
  }

  it("accepts paths, local file URLs and node internals, spaces and parentheses included", () => {
    expect(
      selectFrameLocations([
        site("/srv/my app/(gateway)/handler.js", 42, 7),
        site("file:///srv/my%20app/(gateway)/index.js", 3, 1),
        site("C:\\srv\\gateway\\handler.js", 1, 2),
        site("node:internal/process/task_queues", 105, 5),
      ]),
    ).toEqual([
      "at /srv/my app/(gateway)/handler.js:42:7",
      "at file:///srv/my%20app/(gateway)/index.js:3:1",
      "at C:\\srv\\gateway\\handler.js:1:2",
      "at node:internal/process/task_queues:105:5",
    ]);
  });

  it("rejects eval frames, unsupported locations and invalid coordinates", () => {
    expect(
      selectFrameLocations([
        site("/srv/gateway/handler.js", 1, 1, true),
        site(null),
        site(undefined),
        site(""),
        site("<anonymous>"),
        site("https://example.test/handler.js?token=SYNTHETIC"),
        site("data:text/javascript,SYNTHETIC"),
        site("file://host/srv/handler.js"),
        site("file:///srv/handler.js?v=SYNTHETIC"),
        site("file:///srv/handler.js#SYNTHETIC"),
        site("/srv/handler.js", 0, 1),
        site("/srv/handler.js", 1, -1),
        site("/srv/handler.js", 1.5, 1),
        site("/srv/handler.js", Number.NaN, 1),
        site("/srv/handler.js", 1, 2 ** 53),
        site("/srv/handler.js", "1", 1),
        site("/srv/handler.js", null, 1),
      ]),
    ).toEqual([]);
  });

  it("respects the limits", () => {
    const valid = (i: number) => site(`/srv/gateway/f${i}.js`, i + 1, 1);
    const twenty = Array.from({ length: 20 }, (_, i) => valid(i));
    expect(selectFrameLocations(twenty)).toHaveLength(10);
    expect(selectFrameLocations(twenty)[9]).toBe("at /srv/gateway/f9.js:10:1");

    expect(selectFrameLocations([site(`/${"a".repeat(2000)}.js`)])).toEqual([]);

    const late = [...Array.from({ length: 50 }, () => site(null)), valid(0)];
    expect(selectFrameLocations(late)).toEqual([]);
  });
});
