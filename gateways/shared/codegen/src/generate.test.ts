import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GatewayCheckError } from "./check-gateway.ts";
import { generate } from "./generate.ts";
import {
  CLIENT_DIR,
  CONTRACT_MODULE,
  GENERATED_DIR,
  RUNTIME_DIR,
  VALIDATORS_DIR,
} from "./layout.ts";
import { loadConfig } from "./load-config.ts";

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

const schemasModule = (operations: string) => `
export default { operations: ${operations} };
`;

// The same operation described differently, so the output of one run can be told from another's.
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

async function writeGateway(
  dir: string,
  config: string,
  schemas: string,
): Promise<void> {
  await writeFile(path.join(dir, "gateway.config.ts"), config);
  await writeFile(path.join(dir, "schemas.fixture.ts"), schemas);
}

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
const contractPath = () => path.join(generated(), CLIENT_DIR, CONTRACT_MODULE);

describe("generate", () => {
  it("keeps what the gateway runs apart from what a caller imports", async () => {
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasModule(CREATE_USER_SCHEMAS),
    );

    await generate(tmp);

    const listing = async (...segments: string[]) =>
      (await readdir(path.join(generated(), ...segments))).toSorted();

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
      tmp,
      gatewayModule("{ other: {} }"),
      schemasModule(CREATE_USER_SCHEMAS),
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
      schemasModule(CREATE_USER_SCHEMAS),
    );

    await expect(generate(tmp)).rejects.toThrow(/the driver disagrees/);
    await expect(readdir(generated())).rejects.toThrow();
  });

  it("generates from the schemas as they are, not as a run before it read them", async () => {
    // The validators and the contract are generated from the fixture, and a module is cached by
    // URL: a second run in this process must not describe what the first one read.
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasModule(CREATE_USER_SCHEMAS),
    );
    await generate(tmp);
    expect(await readFile(contractPath(), "utf-8")).toContain(
      "readonly email: string",
    );

    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasModule(RENAMED_SCHEMAS),
    );
    await generate(tmp);

    const contract = await readFile(contractPath(), "utf-8");
    expect(contract).toContain("readonly postcode: string");
    expect(contract).not.toContain("readonly email");
  });

  it("reads the configuration as it is on disk, not as a run before it was", async () => {
    // A module is cached by URL, so a configuration already imported in this process would
    // otherwise be read from memory however the file has changed since.
    await writeGateway(
      tmp,
      gatewayModule("{ createUser: {} }"),
      schemasModule(CREATE_USER_SCHEMAS),
    );
    await loadConfig(tmp);

    await writeFile(
      path.join(tmp, "gateway.config.ts"),
      gatewayModule("{ somethingElse: {} }"),
    );

    await expect(generate(tmp)).rejects.toThrow(GatewayCheckError);
    await expect(readdir(generated())).rejects.toThrow();
  });
});
