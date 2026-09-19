import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayCheckError } from "./check-gateway.ts";
import { generate, stagingPrefix } from "./generate.ts";
import {
  CLIENT_DIR,
  CONTRACT_MODULE,
  GENERATED_DIR,
  RUNTIME_DIR,
  VALIDATORS_DIR,
} from "./layout.ts";
import { loadConfig } from "./load-config.ts";

// Publishing is two renames, and what a failed one must leave behind cannot be arranged from
// outside the filesystem. The first argument of each call decides whether it fails.
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

// A step of the run itself, caught in the middle: writing the output is where a case can act
// while a run is in progress.
const duringWrite: { do: (target: string) => Promise<void> } = {
  do: () => Promise.resolve(),
};

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

// A gateway of the test's own: generation reads a directory, so a case that needs a
// configuration writes one.
const gatewayModule = (operations: string, driverExtra = "") => `
export default {
  id: "generated",
  driver: {
    type: "stub",
    createExecutor: () => Promise.reject(new Error("no executor"))${driverExtra},
  },
  operations: ${operations},
};
`;

const schemasModule = (operations: string, defs = "") => `
export default { ${defs}operations: ${operations} };
`;

const CREATE_USER_SCHEMAS = `{
  createUser: {
    input: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
    outcomes: { created: { type: "object" } },
  },
}`;

// The same operation, described differently: what a second run writes, so the output of one run
// can be told from the other's.
const RENAMED_SCHEMAS = `{
  createUser: {
    input: {
      type: "object",
      properties: { postcode: { type: "string" } },
      required: ["postcode"],
    },
    outcomes: { created: { type: "object" } },
  },
}`;

let tmp: string;

beforeEach(async () => {
  // Under this package rather than the system temp directory: what a gateway's modules import
  // resolves from here, and node_modules is ignored by git.
  tmp = await mkdtemp(
    path.join(import.meta.dirname, "..", "node_modules", ".generate-"),
  );
});

afterEach(async () => {
  failRename.when = () => false;
  failRename.with = () => new Error("rename refused");
  failRm.when = () => false;
  duringWrite.do = () => Promise.resolve();
  await rm(tmp, { recursive: true, force: true });
});

async function writeGateway(config: string, schemas: string): Promise<void> {
  await writeFile(path.join(tmp, "gateway.config.ts"), config);
  await writeFile(path.join(tmp, "schemas.fixture.ts"), schemas);
}

const outDir = () => path.join(tmp, GENERATED_DIR);
const contractPath = () => path.join(outDir(), CLIENT_DIR, CONTRACT_MODULE);

// Directories a run builds in, which a finished run leaves none of.
async function leftovers(): Promise<string[]> {
  const prefix = path.basename(stagingPrefix(outDir()));
  return (await readdir(tmp)).filter((entry) => entry.startsWith(prefix));
}

const CREATE_USER = gatewayModule("{ createUser: {} }");

describe("generate", () => {
  it("keeps what the gateway runs apart from what a caller imports", async () => {
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));

    await generate(tmp);

    const listing = async (...segments: string[]) =>
      (await readdir(path.join(outDir(), ...segments))).toSorted();

    expect(await listing()).toEqual([CLIENT_DIR, RUNTIME_DIR].toSorted());
    expect(await listing(RUNTIME_DIR)).toEqual([VALIDATORS_DIR]);
    expect(await listing(RUNTIME_DIR, VALIDATORS_DIR)).toEqual([
      "index.js",
      "schemas.js",
    ]);
    expect(await listing(CLIENT_DIR)).toEqual([CONTRACT_MODULE]);
  });

  it("emits nothing when the configuration and the schemas disagree", async () => {
    // A mismatch is a generation failure. Emitting part of the output would leave a gateway
    // that builds and dispatches to validators that do not match it.
    await writeGateway(
      gatewayModule("{ other: {} }"),
      schemasModule(CREATE_USER_SCHEMAS),
    );

    await expect(generate(tmp)).rejects.toThrow(GatewayCheckError);
    await expect(readdir(outDir())).rejects.toThrow();
  });

  it("emits nothing when the driver rejects an operation", async () => {
    await writeGateway(
      gatewayModule(
        "{ createUser: {} }",
        ', checkSchemas: () => ["the driver disagrees"]',
      ),
      schemasModule(CREATE_USER_SCHEMAS),
    );

    await expect(generate(tmp)).rejects.toThrow(/the driver disagrees/);
    await expect(readdir(outDir())).rejects.toThrow();
  });

  it("generates from the schemas as they are, not as a run before it read them", async () => {
    // The validators and the contract are generated from the fixture, and a module is cached by
    // URL: a second run in this process must not describe what the first one read.
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await generate(tmp);
    expect(await readFile(contractPath(), "utf-8")).toContain(
      "readonly email: string",
    );

    await writeGateway(CREATE_USER, schemasModule(RENAMED_SCHEMAS));
    await generate(tmp);

    const contract = await readFile(contractPath(), "utf-8");
    expect(contract).toContain("readonly postcode: string");
    expect(contract).not.toContain("readonly email");
  });

  it("reads the configuration as it is on disk, not as a run before it was", async () => {
    // A module is cached by URL, so a configuration already imported in this process would
    // otherwise be read from memory however the file has changed since.
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await loadConfig(tmp);

    await writeFile(
      path.join(tmp, "gateway.config.ts"),
      gatewayModule("{ somethingElse: {} }"),
    );

    await expect(generate(tmp)).rejects.toThrow(GatewayCheckError);
    await expect(readdir(outDir())).rejects.toThrow();
  });

  it("leaves the last complete run in place when a later step fails", async () => {
    // A gateway's two halves must come from the same schemas. Emitting in place would leave a
    // new runtime beside the previous contract when a step after it failed.
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await generate(tmp);
    const before = await readFile(contractPath(), "utf-8");

    // Emitting the contract fails on the reserved name, after the validators are written.
    await writeGateway(
      CREATE_USER,
      schemasModule(RENAMED_SCHEMAS, 'defs: { Record: { type: "object" } }, '),
    );

    await expect(generate(tmp)).rejects.toThrow(
      /both need the type name "Record"/,
    );

    expect(await readFile(contractPath(), "utf-8")).toBe(before);
    expect(
      await readFile(
        path.join(outDir(), RUNTIME_DIR, VALIDATORS_DIR, "schemas.js"),
        "utf-8",
      ),
    ).not.toContain("postcode");
    // Nothing of the failed run is left behind either.
    expect(await leftovers()).toEqual([]);
  });

  it("produces the same output from the same input", async () => {
    // Each run builds in a directory of its own and publishes it whole, so running twice leaves
    // what one run leaves, and nothing of the run itself.
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await generate(tmp);
    const first = await readFile(contractPath(), "utf-8");

    await generate(tmp);

    expect(await readFile(contractPath(), "utf-8")).toBe(first);
    expect(
      (
        await readdir(path.join(outDir(), RUNTIME_DIR, VALIDATORS_DIR))
      ).toSorted(),
    ).toEqual(["index.js", "schemas.js"]);
    expect(await leftovers()).toEqual([]);
  });

  it("takes a gateway directory named relative to the working directory", async () => {
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    const cwd = process.cwd();
    process.chdir(path.dirname(tmp));
    try {
      await generate(path.basename(tmp));
    } finally {
      process.chdir(cwd);
    }

    expect((await readdir(outDir())).toSorted()).toEqual(
      [CLIENT_DIR, RUNTIME_DIR].toSorted(),
    );
    expect(await leftovers()).toEqual([]);
  });

  it("leaves the last complete run in place when publishing fails", async () => {
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await generate(tmp);
    const before = await readFile(contractPath(), "utf-8");

    // The new output cannot be moved into place, so what was there is put back.
    await writeGateway(CREATE_USER, schemasModule(RENAMED_SCHEMAS));
    failRename.when = (from, to) =>
      to === outDir() && !from.endsWith(".previous");
    await expect(generate(tmp)).rejects.toThrow("rename refused");

    expect(await readFile(contractPath(), "utf-8")).toBe(before);
    expect(await leftovers()).toEqual([]);
  });

  it("still reports the failure when the last run cannot be put back", async () => {
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await generate(tmp);
    const before = await readFile(contractPath(), "utf-8");

    // Neither rename can happen, and each fails differently: what the caller hears must be the
    // failure to publish, not the failure to undo it.
    const publishing = new Error("publishing refused");
    failRename.when = (_from, to) => to === outDir();
    failRename.with = (from) =>
      from.endsWith(".previous")
        ? new Error("putting back refused")
        : publishing;

    await expect(generate(tmp)).rejects.toBe(publishing);

    // The last complete run is kept where it landed rather than deleted: it is the only copy
    // left, and a stale directory is easier to recover from than a missing one.
    const [kept] = await leftovers();
    expect(kept).toMatch(/\.previous$/);
    expect(
      await readFile(
        path.join(tmp, kept!, CLIENT_DIR, CONTRACT_MODULE),
        "utf-8",
      ),
    ).toBe(before);
  });

  it("publishes nothing when the last run cannot be moved aside", async () => {
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await generate(tmp);
    const before = await readFile(contractPath(), "utf-8");

    // Anything but "there was nothing there" is a reason to stop.
    await writeGateway(CREATE_USER, schemasModule(RENAMED_SCHEMAS));
    failRename.when = (from) => from === outDir();
    await expect(generate(tmp)).rejects.toThrow("rename refused");

    expect(await readFile(contractPath(), "utf-8")).toBe(before);
  });

  it("publishes nothing into a directory that has none, and cleans up", async () => {
    // Nothing to move aside, so nothing to put back either.
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    failRename.when = (_from, to) => to === outDir();

    await expect(generate(tmp)).rejects.toThrow("rename refused");

    await expect(readdir(outDir())).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("keeps a published run published when the output it replaced cannot be removed", async () => {
    // The swap has happened by then: the new output is what a caller would read, so a failure
    // to tidy up after it is not a failure to generate.
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await generate(tmp);

    await writeGateway(CREATE_USER, schemasModule(RENAMED_SCHEMAS));
    failRm.when = (target) => target.endsWith(".previous");
    await expect(generate(tmp)).resolves.toBeUndefined();

    expect(await readFile(contractPath(), "utf-8")).toContain(
      "readonly postcode:",
    );
    // What it could not remove is left where it is, for the next run or a person to clear.
    expect(await leftovers()).toEqual([expect.stringMatching(/\.previous$/)]);
  });

  it("stops on a rejection it cannot read a code from", async () => {
    await writeGateway(CREATE_USER, schemasModule(CREATE_USER_SCHEMAS));
    await generate(tmp);

    failRename.when = (from) => from === outDir();
    failRename.with = () => "not an error";

    await expect(generate(tmp)).rejects.toBe("not an error");
    expect(await leftovers()).toEqual([]);
  });
});
