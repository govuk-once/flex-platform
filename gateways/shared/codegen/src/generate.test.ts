import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
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
import { generate, stagingPrefix } from "./generate.ts";
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

// Publishing is two renames, and what a failed one must leave behind cannot be arranged from
// outside the filesystem. Which call fails, and with what, is the test's to decide.
const failRename: {
  when: (from: string, to: string) => boolean;
  with: (from: string, to: string) => unknown;
} = {
  when: () => false,
  with: () => new Error("rename refused"),
};

// Removing what a published run replaced is the step after it, and a filesystem that refuses
// it is arranged here for the same reason.
const failRm: { when: (target: string) => boolean } = { when: () => false };

// A configuration that changes while a run is in progress: what a case needs is to act between
// the steps of one, and writing the output is where the run can be caught in the middle.
const duringWrite: { do: (target: string) => Promise<void> } = {
  do: () => Promise.resolve(),
};

// Once, when the entry point is written: after the gateway was read and checked, and before the
// bundle reads it again.
function onceEntryIsWritten(act: () => Promise<void>): void {
  duringWrite.do = async (target) => {
    if (!target.endsWith(ENTRY_MODULE)) return;
    duringWrite.do = () => Promise.resolve();
    await act();
  };
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failRename.when(from, to)) throw failRename.with(from, to);
      return actual.rename(from, to);
    },
    writeFile: async (
      target: Parameters<typeof FsPromises.writeFile>[0],
      data: Parameters<typeof FsPromises.writeFile>[1],
    ) => {
      if (typeof target === "string") await duringWrite.do(target);
      return actual.writeFile(target, data);
    },
    rm: async (
      target: string,
      options?: Parameters<typeof FsPromises.rm>[1],
    ) => {
      if (failRm.when(target)) {
        throw Object.assign(new Error("rm refused"), { code: "EACCES" });
      }
      return actual.rm(target, options);
    },
  };
});

afterEach(() => {
  failRename.when = () => false;
  failRename.with = () => new Error("rename refused");
  failRm.when = () => false;
  duringWrite.do = () => Promise.resolve();
});

// Directories a run builds in, which a finished run leaves none of.
async function leftovers(outDir: string): Promise<string[]> {
  const prefix = path.basename(stagingPrefix(outDir));
  return (await readdir(path.dirname(outDir))).filter((entry) =>
    entry.startsWith(prefix),
  );
}

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

// Waits for the file a loading gateway writes when it has reached the point it holds at. A run
// that fails before it gets there ends the wait too: that failure is the more useful report, and
// the case makes it against the run itself.
async function reached(marker: string, run: Promise<unknown>): Promise<void> {
  const settled = run.then(
    () => true,
    () => true,
  );
  const until = Date.now() + 30_000;
  while (!existsSync(marker)) {
    const ended = await Promise.race([
      settled,
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 5);
      }),
    ]);
    if (ended) return;
    if (Date.now() > until) {
      throw new Error(`${path.basename(marker)} was never written`);
    }
  }
}

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

  it("takes the state of the gateway from before its modules are evaluated", async () => {
    // Loading runs the gateway's own modules, which takes as long as they take. A configuration
    // changed while that happens is read by nothing in this run — the module Node evaluated is
    // the one from before — so it must not be recorded as the state the run started from.
    await writeGateway(
      tmp,
      `
import { existsSync, writeFileSync } from "node:fs";

// Held here so a case can change a file while this module is being evaluated. A gateway's own
// configuration reaches nothing of the sort; this is the test standing in the middle of a load.
// The wait is bounded: a case that fails before it releases this module ends its run all the
// same, and the failure it reports is its own rather than a timeout around a module still held.
writeFileSync(new URL("./started", import.meta.url), "");
const held = Date.now() + 30_000;
while (
  !existsSync(new URL("./proceed", import.meta.url)) &&
  Date.now() < held
) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
${gatewayModule("{ createUser: {} }")}`,
      schemasVersion(CREATE_USER_SCHEMAS),
    );

    const run = generate(tmp);
    try {
      await reached(path.join(tmp, "started"), run);
      // What the bundle would read from here on, and what nothing in this run has checked.
      await writeFile(
        path.join(tmp, "gateway.config.ts"),
        gatewayModule("{ createUser: {}, andAnother: {} }"),
      );
    } finally {
      // Released whatever happened above, so the run ends and reports what it found.
      await writeFile(path.join(tmp, "proceed"), "");
    }

    await expect(run).rejects.toThrow(/changed while it was being generated/);
    await expect(readdir(generated())).rejects.toThrow();
  }, 60_000);

  it("publishes nothing when the configuration changes while it runs", async () => {
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasVersion(CREATE_USER_SCHEMAS),
    );

    // Changed after it was read and checked, while the output was being built: the bundle would
    // carry a configuration nothing checked.
    onceEntryIsWritten(() =>
      writeFile(
        path.join(tmp, "gateway.config.ts"),
        gatewayModule("{ createUser: {}, andAnother: {} }"),
      ),
    );

    await expect(generate(tmp)).rejects.toThrow(
      /changed while it was being generated/,
    );
    await expect(readdir(generated())).rejects.toThrow();
    expect(await leftovers(generated())).toEqual([]);
  }, 60_000);

  it("publishes nothing when the schemas change while it runs", async () => {
    // The validators were compiled from the version as it was read. One rewritten since then is
    // what the next run would generate from, and what this run would be published beside.
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasVersion(CREATE_USER_SCHEMAS),
    );

    onceEntryIsWritten(() =>
      writeFile(path.join(tmp, FIRST_VERSION), schemasVersion(RENAMED_SCHEMAS)),
    );

    await expect(generate(tmp)).rejects.toThrow(
      /changed while it was being generated/,
    );
    await expect(readdir(generated())).rejects.toThrow();
    expect(await leftovers(generated())).toEqual([]);
  }, 60_000);

  it("publishes nothing when a module it imports changes while it runs", async () => {
    // The bundle reads whatever the configuration imports, so what is read at the end is every
    // file the gateway is made of, not only the configuration and the schemas.
    await writeFile(
      path.join(tmp, "handler-of-sorts.ts"),
      "export default { note: 'first' };\n",
    );
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasVersion(CREATE_USER_SCHEMAS),
    );

    onceEntryIsWritten(() =>
      writeFile(
        path.join(tmp, "handler-of-sorts.ts"),
        "export default { note: 'second' };\n",
      ),
    );

    await expect(generate(tmp)).rejects.toThrow(
      /changed while it was being generated/,
    );
    await expect(readdir(generated())).rejects.toThrow();
    expect(await leftovers(generated())).toEqual([]);
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

  async function clearLeftovers(): Promise<void> {
    for (const stale of await leftovers(outDir)) {
      await rm(path.join(fixtureDir, stale), { recursive: true, force: true });
    }
  }

  beforeAll(async () => {
    // A run that was stopped before it could publish leaves its directory behind; clear any
    // from a previous run of these tests, so what a publication leaves is what is counted.
    await clearLeftovers();

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

  it("leaves the last complete run in place when a later step fails", async () => {
    // A gateway's two halves must come from the same schemas. Emitting in place would leave a
    // new bundle beside the previous contract when a step after it failed.
    const before = {
      contract: await readFile(contract, "utf-8"),
      bundle: await readFile(bundlePath, "utf-8"),
    };

    // The contract is written after the bundle is built, so this is a run that fails late.
    duringWrite.do = (target) =>
      target.endsWith(CONTRACT_MODULE)
        ? Promise.reject(new Error("write refused"))
        : Promise.resolve();

    await expect(generate(fixtureDir)).rejects.toThrow("write refused");

    expect(await readFile(contract, "utf-8")).toBe(before.contract);
    expect(await readFile(bundlePath, "utf-8")).toBe(before.bundle);
    // Nothing of the failed run is left behind either.
    expect(await leftovers(outDir)).toEqual([]);
  }, 60_000);

  it("produces the same bundle from the same input", async () => {
    // A run builds in a directory of its own and names the modules it bundles relative to the
    // one they are published in, so the same gateway bundles to the same bytes.
    await generate(fixtureDir);

    expect(await readFile(bundlePath, "utf-8")).toBe(bundle);
    expect(await leftovers(outDir)).toEqual([]);
  }, 60_000);

  // Publishing is the last step, and what it leaves when it fails is the guarantee.

  it("leaves the last complete run in place when publishing fails", async () => {
    const before = await readFile(contract, "utf-8");

    // The new output cannot be moved into place, so what was there is put back.
    failRename.when = (from, to) =>
      to === outDir && !from.endsWith(".previous");
    await expect(generate(fixtureDir)).rejects.toThrow("rename refused");

    expect(await readFile(contract, "utf-8")).toBe(before);
    expect(await leftovers(outDir)).toEqual([]);
  }, 60_000);

  it("clears out what an interrupted run left behind", async () => {
    // A run that fails removes its own directory; one that is killed cannot, and what it was
    // building is still there when the next run starts.
    const abandoned = await mkdtemp(stagingPrefix(outDir));
    await writeFile(path.join(abandoned, "half-written.js"), "");

    await generate(fixtureDir);

    expect(await leftovers(outDir)).toEqual([]);
  }, 60_000);

  it("leaves the copy a failed publication kept", async () => {
    // The last complete run's output, where publication could neither finish nor be undone. A
    // run that swept it away would take the only copy of it with it.
    const previous = `${await mkdtemp(stagingPrefix(outDir))}.previous`;
    await mkdir(previous);

    await generate(fixtureDir);

    // Read before it is cleared, so what the next case counts is what that case leaves.
    const kept = await leftovers(outDir);
    await rm(previous, { recursive: true, force: true });
    expect(kept).toEqual([path.basename(previous)]);
  }, 60_000);

  it("still reports the failure when the last run cannot be put back", async () => {
    const before = {
      contract: await readFile(contract, "utf-8"),
      bundle: await readFile(bundlePath, "utf-8"),
    };

    // Neither rename can happen, and each fails differently: what the caller hears must be the
    // failure to publish, not the failure to undo it.
    const publishing = new Error("publishing refused");
    failRename.when = (_from, to) => to === outDir;
    failRename.with = (from) =>
      from.endsWith(".previous")
        ? new Error("putting back refused")
        : publishing;

    await expect(generate(fixtureDir)).rejects.toBe(publishing);

    // The last complete run is kept where it landed rather than deleted: it is the only copy
    // left, and a stale directory is easier to recover from than a missing one.
    const [kept] = await leftovers(outDir);
    expect(kept).toMatch(/\.previous$/);
    const keptDir = path.join(fixtureDir, kept!);
    expect(
      await readFile(path.join(keptDir, CLIENT_DIR, CONTRACT_MODULE), "utf-8"),
    ).toBe(before.contract);
    expect(
      await readFile(path.join(keptDir, RUNTIME_DIR, BUNDLE_MODULE), "utf-8"),
    ).toBe(before.bundle);

    failRename.when = () => false;
    await clearLeftovers();
    await generate(fixtureDir);
  }, 60_000);

  it("publishes nothing into a directory that has none, and cleans up", async () => {
    // Nothing to move aside, so nothing to put back either.
    await rm(outDir, { recursive: true, force: true });
    failRename.when = (_from, to) => to === outDir;

    await expect(generate(fixtureDir)).rejects.toThrow("rename refused");

    await expect(readdir(outDir)).rejects.toThrow();
    expect(await leftovers(outDir)).toEqual([]);

    failRename.when = () => false;
    await generate(fixtureDir);
  }, 60_000);

  it("keeps a published run published when the output it replaced cannot be removed", async () => {
    // The swap has happened by then: the new output is what a deployment would read, so a
    // failure to tidy is not a failure to generate.
    failRm.when = (target) => target.endsWith(".previous");

    await expect(generate(fixtureDir)).resolves.toBeUndefined();

    expect(await readFile(contract, "utf-8")).toContain("// GENERATED FILE.");
    // What it could not remove is left where it is, for the next run or a person to clear.
    expect(await leftovers(outDir)).toEqual([
      expect.stringMatching(/\.previous$/),
    ]);

    failRm.when = () => false;
    await clearLeftovers();
  }, 60_000);

  it("stops on a rejection it cannot read a code from", async () => {
    failRename.when = (from) => from === outDir;
    failRename.with = () => "not an error";

    await expect(generate(fixtureDir)).rejects.toBe("not an error");
    expect(await leftovers(outDir)).toEqual([]);
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
      `RESPONSE ${JSON.stringify({ ok: true, outcome: "created", data: { id: "fixture" } })}`,
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
