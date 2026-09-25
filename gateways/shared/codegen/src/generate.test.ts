import { execFile as execFileCb } from "node:child_process";
import type * as FsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { GatewayError } from "@repo/gateway-runtime";
import type { EnvelopeResponse } from "@repo/gateway-types";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { stub } from "../test/fixture/driver.ts";
import { GatewayCheckError } from "./check-gateway.ts";
import { SchemaCompatibilityError } from "./compare-schemas.ts";
import { generate } from "./generate.ts";
import {
  BUNDLE_MODULE,
  CLIENT_DIR,
  CONTRACT_MODULE,
  ENTRY_MODULE,
  GENERATED_DIR,
  RUNTIME_DIR,
  SCHEMAS_DIR,
  VALIDATORS_DIR,
} from "./layout.ts";
import { loadConfig } from "./load-config.ts";

const TARGET = "https://fixture.test";
// Shaped as the runtime requires; nothing is retrieved from it, since the stub driver reads no
// secret. SYNTHETIC account and secret name.
const SECRET_ARN =
  "arn:aws:secretsmanager:eu-west-2:000000000000:secret:fixture-SYNTHETIC";

const execFile = promisify(execFileCb);

// A write that fails part way through a run, which cannot be arranged from outside the
// filesystem. Which write fails is the test's to decide.
const duringWrite: { do: (target: string) => Promise<void> } = {
  do: () => Promise.resolve(),
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    writeFile: async (
      target: Parameters<typeof FsPromises.writeFile>[0],
      data: Parameters<typeof FsPromises.writeFile>[1],
    ) => {
      if (typeof target === "string") await duringWrite.do(target);
      return actual.writeFile(target, data);
    },
  };
});

afterEach(() => {
  duringWrite.do = () => Promise.resolve();
});

// A gateway of the test's own, written where a configuration module resolves what it imports:
// generation reads the directory, so a case that needs a configuration writes one.
const STUB_DRIVER = `{
  type: "stub",
  createExecutor: () => Promise.reject(new Error("no executor")),
}`;

const gatewayModule = (operations: string, driverExtra = "") => `
export default {
  id: "generated",
  driver: { ...${STUB_DRIVER}${driverExtra} },
  operations: ${operations},
};
`;

// A gateway's schemas as its first version holds them.
const schemasVersion = (operations: object): string =>
  JSON.stringify({ operations });

const CREATE_USER_SCHEMAS = {
  createUser: {
    input: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
    outcomes: { created: { type: "object" } },
  },
};

// The same operation described differently, so the output of one run can be told from another's.
const RENAMED_SCHEMAS = {
  createUser: {
    input: {
      type: "object",
      properties: { postcode: { type: "string" } },
      required: ["postcode"],
    },
    outcomes: { created: { type: "object" } },
  },
};

const FIRST_VERSION = path.join(SCHEMAS_DIR, "0001.json");

async function writeGateway(
  dir: string,
  config: string,
  schemas: string,
): Promise<void> {
  await writeFile(path.join(dir, "gateway.config.ts"), config);
  await mkdir(path.join(dir, SCHEMAS_DIR), { recursive: true });
  await writeFile(path.join(dir, FIRST_VERSION), schemas);
}

describe("generate", () => {
  let tmp: string;

  beforeEach(async () => {
    // Under this package rather than the system temp directory: what a gateway's modules import
    // resolves from here, and node_modules is ignored by git.
    tmp = await mkdtemp(
      path.join(import.meta.dirname, "..", "node_modules", ".generate-"),
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const generated = () => path.join(tmp, GENERATED_DIR);
  const contractPath = () =>
    path.join(generated(), CLIENT_DIR, CONTRACT_MODULE);

  it("emits nothing when the configuration and the schemas disagree", async () => {
    // A mismatch is a generation failure. Emitting part of the output would leave a gateway
    // that builds and dispatches to validators that do not match it.
    await writeGateway(
      tmp,
      gatewayModule("{ other: {} }"),
      schemasVersion(CREATE_USER_SCHEMAS),
    );

    await expect(generate(tmp)).rejects.toThrow(GatewayCheckError);
    await expect(readdir(generated())).rejects.toThrow();
  });

  it("emits nothing when the driver rejects an operation", async () => {
    await writeGateway(
      tmp,
      gatewayModule(
        "{ createUser: {} }",
        ', checkSchemas: () => ["the driver disagrees"]',
      ),
      schemasVersion(CREATE_USER_SCHEMAS),
    );

    await expect(generate(tmp)).rejects.toThrow(/the driver disagrees/);
    await expect(readdir(generated())).rejects.toThrow();
  });

  it("generates from the latest version when each follows the one before it safely", async () => {
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasVersion(CREATE_USER_SCHEMAS),
    );
    // The same input, with a field a caller may now leave out.
    await writeFile(
      path.join(tmp, SCHEMAS_DIR, "0002.json"),
      schemasVersion({
        createUser: {
          ...CREATE_USER_SCHEMAS.createUser,
          input: { ...CREATE_USER_SCHEMAS.createUser.input, required: [] },
        },
      }),
    );

    await generate(tmp);

    expect(await readFile(contractPath(), "utf-8")).toContain(
      "readonly email?: string",
    );
  }, 60_000);

  it("describes each operation in the contract as the configuration describes it", async () => {
    await writeGateway(
      tmp,
      gatewayModule('{ createUser: { description: "Creates a user record" } }'),
      schemasVersion(CREATE_USER_SCHEMAS),
    );

    await generate(tmp);

    expect(await readFile(contractPath(), "utf-8")).toContain(
      "/** Creates a user record */\nexport type CreateUserInput",
    );
  }, 60_000);

  it("emits nothing when a version breaks the one before it", async () => {
    // A caller written against the first version sends `email`, which the second has no field
    // for. The configuration agrees with the second, so nothing else would refuse it.
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasVersion(CREATE_USER_SCHEMAS),
    );
    await writeFile(
      path.join(tmp, SCHEMAS_DIR, "0002.json"),
      schemasVersion(RENAMED_SCHEMAS),
    );

    const run = generate(tmp);
    await expect(run).rejects.toThrow(SchemaCompatibilityError);
    await expect(run).rejects.toThrow(
      /0001 -> 0002: operations\.createUser\.input\.properties\.email: was removed/,
    );
    await expect(readdir(generated())).rejects.toThrow();
  });

  it("reads the configuration as it is on disk, not as a run before it was", async () => {
    // Node caches a module by URL, so a configuration already imported in this process would
    // otherwise be read from memory while esbuild bundles what the file says now.
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasVersion(CREATE_USER_SCHEMAS),
    );
    await loadConfig(tmp);

    await writeFile(
      path.join(tmp, "gateway.config.ts"),
      gatewayModule("{ somethingElse: {} }"),
    );

    await expect(generate(tmp)).rejects.toThrow(GatewayCheckError);
    await expect(readdir(generated())).rejects.toThrow();
  });

  it("generates from the schemas as they are, not as a run before it read them", async () => {
    // The validators and the contract are generated from the latest version, which is parsed
    // from the file each time: a second run in this process must not describe what the first read.
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasVersion(CREATE_USER_SCHEMAS),
    );
    await generate(tmp);
    expect(await readFile(contractPath(), "utf-8")).toContain(
      "readonly email: string",
    );

    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasVersion(RENAMED_SCHEMAS),
    );
    await generate(tmp);

    const contract = await readFile(contractPath(), "utf-8");
    expect(contract).toContain("readonly postcode: string");
    expect(contract).not.toContain("readonly email");
  }, 60_000);
});

describe("the generated gateway", () => {
  const fixtureDir = path.join(import.meta.dirname, "..", "test", "fixture");
  const outDir = path.join(fixtureDir, GENERATED_DIR);
  const contract = path.join(outDir, CLIENT_DIR, CONTRACT_MODULE);
  const bundlePath = path.join(outDir, RUNTIME_DIR, BUNDLE_MODULE);

  interface LambdaContext {
    getRemainingTimeInMillis(): number;
  }

  let handler: (
    event: unknown,
    context: LambdaContext,
  ) => Promise<EnvelopeResponse>;
  let bundle: string;

  const call = (operation: string, input: unknown) => ({
    operation,
    input,
    secure: { values: {}, signature: "" },
  });

  const context: LambdaContext = { getRemainingTimeInMillis: () => 30_000 };

  beforeAll(async () => {
    // What the CLI does, on a gateway of this package's own.
    await generate(fixtureDir);

    // The deployment, as the platform supplies it: the entry point reads it while it loads.
    vi.stubEnv("UPSTREAM_TARGET", TARGET);
    vi.stubEnv("UPSTREAM_SECRET_ARN", SECRET_ARN);

    bundle = await readFile(bundlePath, "utf-8");
    // The generated module, loaded as the platform loads the bundle's entry point. The
    // specifier is built rather than written, so nothing typechecked imports generated code.
    const entryModule = [
      "../test/fixture",
      GENERATED_DIR,
      RUNTIME_DIR,
      ENTRY_MODULE,
    ].join("/");
    const entry = (await import(entryModule)) as { handler: typeof handler };
    handler = entry.handler;
  }, 60_000);

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("keeps what the gateway runs apart from what a caller imports", async () => {
    const listing = async (...segments: string[]) =>
      (await readdir(path.join(outDir, ...segments))).toSorted();

    expect(await listing()).toEqual([CLIENT_DIR, RUNTIME_DIR].toSorted());
    expect(await listing(RUNTIME_DIR)).toEqual(
      [ENTRY_MODULE, BUNDLE_MODULE, VALIDATORS_DIR].toSorted(),
    );
    expect(await listing(RUNTIME_DIR, VALIDATORS_DIR)).toEqual([
      "index.js",
      "schemas.js",
    ]);
    expect(await listing(CLIENT_DIR)).toEqual([CONTRACT_MODULE]);
  });

  it("fails a run whose output cannot be written, and the next replaces what it left", async () => {
    // The contract is written last, so this is a run that fails after the bundle was built.
    duringWrite.do = (target) =>
      target.endsWith(CONTRACT_MODULE)
        ? Promise.reject(new Error("write refused"))
        : Promise.resolve();
    await expect(generate(fixtureDir)).rejects.toThrow("write refused");
    await expect(readFile(contract, "utf-8")).rejects.toThrow();

    duringWrite.do = () => Promise.resolve();
    await generate(fixtureDir);
    expect(await readFile(contract, "utf-8")).toContain("// GENERATED FILE.");
    expect(await readFile(bundlePath, "utf-8")).toBe(bundle);
  }, 60_000);

  it("produces the same bundle from the same input", async () => {
    await generate(fixtureDir);

    expect(await readFile(bundlePath, "utf-8")).toBe(bundle);
  }, 60_000);

  it("bundles everything but Node's own builtins", () => {
    // A gateway that cannot be bundled fails generation, and nothing but a builtin is left for
    // the platform to resolve: what the deployment runs is the version the lockfile pinned.
    const imported = [
      ...bundle.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm),
    ]
      .map((match) => match[1] ?? "")
      .filter((specifier) => !specifier.startsWith("node:"));

    expect(bundle.startsWith("// GENERATED FILE.")).toBe(true);
    expect(imported).toEqual([]);
    expect(bundle).toMatch(/export\s*\{[^}]*\bhandler\b/);
  });

  it("starts under plain Node and answers an invocation", async () => {
    // The deployed artifact, run as the platform runs it: a fresh Node process loading the
    // bundle, which reads the environment and builds the handler as it loads. Importing the
    // entry point instead would not catch what only the bundle has, such as a bundled
    // dependency reaching for `require`.
    const script = `
      process.env.UPSTREAM_TARGET = ${JSON.stringify(TARGET)};
      process.env.UPSTREAM_SECRET_ARN = ${JSON.stringify(SECRET_ARN)};
      const { handler } = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
      const response = await handler(
        ${JSON.stringify(call("createUser", { payload: { email: "a@b.test" } }))},
        { getRemainingTimeInMillis: () => 30000 },
      );
      // Marked, because the handler logs its own line to stdout.
      console.log("RESPONSE " + JSON.stringify(response));
    `;

    const { stdout } = await execFile(process.execPath, [
      "--input-type=module",
      "-e",
      script,
    ]);
    const answer = stdout
      .split("\n")
      .find((line) => line.startsWith("RESPONSE "));

    expect(answer).toBe(
      `RESPONSE ${JSON.stringify({ ok: true, outcome: "created", data: { id: "fixture" }, meta: { requestId: "fixture-request" } })}`,
    );
  }, 60_000);

  it("gives the driver the deployment the entry point read", () => {
    expect(stub.options?.target).toBe(TARGET);
  });

  it("dispatches a valid request and returns the driver's outcome", async () => {
    const seen: unknown[] = [];
    stub.execute = (_ctx, operation, input) => {
      seen.push({ operation, input });
      return Promise.resolve({ outcome: "created", data: { id: "u-1" } });
    };

    await expect(
      handler(call("createUser", { payload: { email: "a@b.test" } }), context),
    ).resolves.toEqual({ ok: true, outcome: "created", data: { id: "u-1" } });
    expect(seen).toEqual([
      { operation: "createUser", input: { payload: { email: "a@b.test" } } },
    ]);
  });

  it("returns what the driver reported beside a failure, validated as the gateway declares it", async () => {
    stub.execute = (ctx) => {
      ctx.meta("requestId", "req-1");
      ctx.meta("undeclared", "never returned");
      return Promise.reject(
        new GatewayError("UPSTREAM_ERROR", "upstream said 500"),
      );
    };
    await expect(
      handler(call("createUser", { payload: { email: "a@b.test" } }), context),
    ).resolves.toEqual({
      ok: false,
      error: { code: "UPSTREAM_ERROR" },
      meta: { requestId: "req-1" },
    });

    // The generated validator decides: what it refuses is left out, and the call still answers.
    stub.execute = (ctx) => {
      ctx.meta("requestId", 42);
      return Promise.resolve({ outcome: "created", data: { id: "u-1" } });
    };
    await expect(
      handler(call("createUser", { payload: { email: "a@b.test" } }), context),
    ).resolves.toEqual({ ok: true, outcome: "created", data: { id: "u-1" } });
  });

  it("rejects input the generated validators refuse", async () => {
    stub.execute = () => Promise.reject(new Error("the driver must not run"));

    await expect(
      handler(call("createUser", { payload: {} }), context),
    ).resolves.toEqual({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("rejects an outcome the generated validators refuse", async () => {
    stub.execute = () =>
      Promise.resolve({ outcome: "created", data: { wrong: "shape" } });

    await expect(
      handler(call("createUser", { payload: { email: "a@b.test" } }), context),
    ).resolves.toEqual({
      ok: false,
      error: { code: "UPSTREAM_CONTRACT_VIOLATION" },
    });
  });

  it("rejects an operation the gateway does not define", async () => {
    stub.execute = () => Promise.reject(new Error("the driver must not run"));

    await expect(handler(call("deleteUser", {}), context)).resolves.toEqual({
      ok: false,
      error: { code: "OPERATION_NOT_FOUND" },
    });
  });

  it("takes the deadline from the invocation", async () => {
    stub.execute = (ctx) =>
      ctx.upstream(() =>
        Promise.resolve({ outcome: "created", data: { id: "u-1" } }),
      );

    // An exhausted budget stops the request before the driver reaches its upstream.
    await expect(
      handler(call("createUser", { payload: { email: "a@b.test" } }), {
        getRemainingTimeInMillis: () => 0,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "UPSTREAM_TIMEOUT" } });
  });
});
