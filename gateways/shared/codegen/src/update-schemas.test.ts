import { execFile as execFileCb } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { GatewaySchemas } from "@repo/gateway-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GatewayCheckError } from "./check-gateway.ts";
import { SchemaCompatibilityError } from "./compare-schemas.ts";
import { SCHEMAS_DIR } from "./layout.ts";
import { SchemaStoreError } from "./schema-store.ts";
import { main } from "./schemas-cli.ts";
import { formatReport, updateSchemas } from "./update-schemas.ts";

const execFile = promisify(execFileCb);

// A gateway whose driver derives its schemas from a file beside it, so a case decides what the
// upstream "says" by writing that file. Read when deriving runs, not when the module loads:
// Node keeps a module it has evaluated, and a case derives more than once.
const DERIVING = `
export default {
  id: "derived",
  driver: {
    type: "stub",
    createExecutor: () => Promise.reject(new Error("no executor")),
    deriveSchemasModule: new URL("./derive.ts", import.meta.url).href,
  },
  operations: { getThing: {} },
};
`;

const DERIVE = `
export default async function derive(config, sources) {
  const upstream = JSON.parse(await sources.load("upstream.json"));
  return { schemas: upstream.schemas, notes: upstream.notes ?? [] };
}
`;

const HAND_MAINTAINED = `
export default {
  id: "by-hand",
  driver: { type: "stub", createExecutor: () => Promise.reject(new Error("no executor")) },
  operations: { getThing: {} },
};
`;

const thing = (
  properties: Record<string, unknown>,
  required: readonly string[] = ["id"],
): GatewaySchemas => ({
  operations: {
    getThing: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      outcomes: { ok: { type: "object", properties, required } },
    },
  },
});

const FIRST = thing({ id: { type: "string" }, name: { type: "string" } });

let gatewayDir: string;

beforeEach(async () => {
  gatewayDir = await mkdtemp(
    path.join(import.meta.dirname, "..", "node_modules", ".schemas-"),
  );
  await writeFile(path.join(gatewayDir, "gateway.config.ts"), DERIVING);
  await writeFile(path.join(gatewayDir, "derive.ts"), DERIVE);
});

afterEach(async () => {
  await rm(gatewayDir, { recursive: true, force: true });
});

const upstreamSays = (schemas: unknown, notes?: readonly string[]) =>
  writeFile(
    path.join(gatewayDir, "upstream.json"),
    JSON.stringify({ schemas, notes }),
  );

const versions = async (): Promise<string[]> =>
  (
    await readdir(path.join(gatewayDir, SCHEMAS_DIR)).catch(() => [])
  ).toSorted();

const version = (name: string) =>
  readFile(path.join(gatewayDir, SCHEMAS_DIR, `${name}.json`), "utf-8");

describe("updateSchemas", () => {
  it("writes the first version of a gateway that has none, in the order it was derived in", async () => {
    await upstreamSays(FIRST, ["a note for whoever reviews it"]);

    const report = await updateSchemas(gatewayDir);

    expect(report).toEqual({
      gatewayId: "derived",
      update: {
        status: "written",
        version: "0001",
        changes: ["the first version"],
      },
      notes: ["a note for whoever reviews it"],
    });
    expect(await versions()).toEqual(["0001.json"]);
    // Two-space JSON in the order given: `id` before `name`, `type` before `properties`.
    expect(await version("0001")).toBe(`${JSON.stringify(FIRST, null, 2)}\n`);
  });

  it("writes nothing when the upstream's shape is what the latest version holds", async () => {
    await upstreamSays(FIRST);
    await updateSchemas(gatewayDir);

    expect((await updateSchemas(gatewayDir)).update).toEqual({
      status: "unchanged",
      latest: "0001",
    });
    expect(await versions()).toEqual(["0001.json"]);
  });

  it("writes nothing when only what the upstream says about its fields has changed", async () => {
    // A description is not a contract a caller could tell from the last, so it is no version.
    await upstreamSays(FIRST);
    await updateSchemas(gatewayDir);
    const before = await version("0001");

    await upstreamSays(
      thing({
        id: { type: "string", description: "Reworded since" },
        name: { type: "string", deprecated: true },
      }),
    );

    expect((await updateSchemas(gatewayDir)).update.status).toBe("unchanged");
    expect(await versions()).toEqual(["0001.json"]);
    expect(await version("0001")).toBe(before);
  });

  it("writes the next version when the shape changed and no caller breaks", async () => {
    await upstreamSays(FIRST);
    await updateSchemas(gatewayDir);
    const next = thing({
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
    });
    await upstreamSays(next);

    expect((await updateSchemas(gatewayDir)).update).toEqual({
      status: "written",
      version: "0002",
      changes: ["operations.getThing.outcomes.ok.properties.email: was added"],
    });
    expect(await versions()).toEqual(["0001.json", "0002.json"]);
    expect(await version("0002")).toBe(`${JSON.stringify(next, null, 2)}\n`);
  });

  it("refuses a change that breaks a caller, and writes nothing", async () => {
    await upstreamSays(FIRST);
    await updateSchemas(gatewayDir);
    await upstreamSays(thing({ id: { type: "string" } }));

    expect((await updateSchemas(gatewayDir)).update).toEqual({
      status: "breaking",
      latest: "0001",
      problems: [
        "operations.getThing.outcomes.ok.properties.name: was removed",
      ],
    });
    expect(await versions()).toEqual(["0001.json"]);
  });

  it.each([
    [
      "the wrong shape",
      { operations: { getThing: { input: {} } } },
      SchemaStoreError,
    ],
    [
      "a character that does not display",
      thing({ id: { type: "string", description: "fine\u202Etext" } }),
      SchemaStoreError,
    ],
    [
      "a schema the validators cannot be built from",
      thing({ id: { type: "string", nullable: "yes" } }),
      Error,
    ],
    [
      "operations that are not the configuration's",
      { operations: { other: { input: {}, outcomes: { ok: {} } } } },
      GatewayCheckError,
    ],
  ])(
    "refuses derived schemas with %s, and writes nothing",
    async (_what, schemas, error) => {
      await upstreamSays(schemas);

      await expect(updateSchemas(gatewayDir)).rejects.toThrow(error);
      expect(await versions()).toEqual([]);
    },
  );

  it("adds nothing to a history that already breaks a caller", async () => {
    await mkdir(path.join(gatewayDir, SCHEMAS_DIR));
    await writeFile(
      path.join(gatewayDir, SCHEMAS_DIR, "0001.json"),
      JSON.stringify(FIRST),
    );
    await writeFile(
      path.join(gatewayDir, SCHEMAS_DIR, "0002.json"),
      JSON.stringify(thing({ id: { type: "string" } })),
    );
    await upstreamSays(thing({ id: { type: "string" }, extra: {} }));

    await expect(updateSchemas(gatewayDir)).rejects.toThrow(
      SchemaCompatibilityError,
    );
    expect(await versions()).toEqual(["0001.json", "0002.json"]);
  });

  it("checks the versions of a gateway whose driver derives nothing, and writes none", async () => {
    await writeFile(
      path.join(gatewayDir, "gateway.config.ts"),
      HAND_MAINTAINED,
    );
    await mkdir(path.join(gatewayDir, SCHEMAS_DIR));
    await writeFile(
      path.join(gatewayDir, SCHEMAS_DIR, "0001.json"),
      JSON.stringify(FIRST),
    );

    expect(await updateSchemas(gatewayDir)).toEqual({
      gatewayId: "by-hand",
      update: { status: "hand-maintained", versions: 1 },
      notes: [],
    });

    await writeFile(
      path.join(gatewayDir, SCHEMAS_DIR, "0002.json"),
      JSON.stringify(thing({ id: { type: "string" } })),
    );
    await expect(updateSchemas(gatewayDir)).rejects.toThrow(
      SchemaCompatibilityError,
    );
  });

  it("holds the latest hand-written version to what generation holds it to", async () => {
    // Nothing derived it, so nothing else has read it: a command whose job is to say whether a
    // gateway's schemas are sound must not call one sound that `codegen` refuses.
    await writeFile(
      path.join(gatewayDir, "gateway.config.ts"),
      HAND_MAINTAINED,
    );
    await mkdir(path.join(gatewayDir, SCHEMAS_DIR));
    const write = (schemas: unknown) =>
      writeFile(
        path.join(gatewayDir, SCHEMAS_DIR, "0001.json"),
        JSON.stringify(schemas),
      );

    await write({
      operations: {
        getThing: {
          input: { type: "not-a-type" },
          outcomes: { ok: { type: "object" } },
        },
      },
    });
    await expect(updateSchemas(gatewayDir)).rejects.toThrow(
      /Invalid schema for input of operation "getThing"/,
    );

    // An operation the configuration does not declare, which the driver's own reading catches.
    await write({
      operations: {
        ...FIRST.operations,
        getOther: FIRST.operations.getThing,
      },
    });
    await expect(updateSchemas(gatewayDir)).rejects.toThrow(GatewayCheckError);
  });

  it.each(["derives", "./derive.ts", "https://upstream.test/derive.js"])(
    "refuses %s as the module that derives, which is not a file: URL",
    async (location) => {
      await writeFile(
        path.join(gatewayDir, "gateway.config.ts"),
        DERIVING.replace(
          'new URL("./derive.ts", import.meta.url).href',
          JSON.stringify(location),
        ),
      );
      await upstreamSays(FIRST);

      await expect(updateSchemas(gatewayDir)).rejects.toThrow(
        `The driver gives "${location}" as the module that derives its schemas, which is not a file: URL`,
      );
    },
  );

  it("says so when the module a driver gives is not there, or derives nothing", async () => {
    await upstreamSays(FIRST);
    await rm(path.join(gatewayDir, "derive.ts"));
    await expect(updateSchemas(gatewayDir)).rejects.toThrow(
      /derive\.ts" as the module that derives its schemas, which is not there/,
    );

    await writeFile(
      path.join(gatewayDir, "derive.ts"),
      "export const nothing = 1;\n",
    );
    await expect(updateSchemas(gatewayDir)).rejects.toThrow(
      /must export the function that derives schemas as its default/,
    );
  });
});

describe("formatReport", () => {
  it("writes what does not display as what it is, wherever upstream text reaches it", () => {
    // A note carries whatever a driver read from an upstream's own document, and a break names
    // the fields that broke, which are the upstream's names. A terminal acts on an escape
    // sequence in either, and could roll the cursor back over the line that said BREAKING.
    const report = formatReport({
      gatewayId: "udp",
      update: {
        status: "breaking",
        latest: "0001",
        problems: [
          "operations.getThing.input.properties.\u001b[2Aid: was removed",
        ],
      },
      notes: ["the upstream said \u001b[1G\u0007so, and \u202enothing else"],
    });

    // The line breaks the report is laid out with are its own; nothing else survives.
    expect(report.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(report).toContain("U+001B[2Aid: was removed");
    expect(report).toContain("U+202Enothing else");
    expect(report).toContain("BREAKING CHANGE");
  });

  it("says what happened to each kind of gateway", () => {
    expect(
      formatReport({
        gatewayId: "udp",
        update: { status: "unchanged", latest: "0003" },
        notes: [],
      }),
    ).toBe("udp: unchanged; schemas/0003.json is still the upstream's shape");
    expect(
      formatReport({
        gatewayId: "udp",
        update: { status: "hand-maintained", versions: 2 },
        notes: [],
      }),
    ).toBe(
      "udp: hand-maintained; 2 versions, each safe for a caller of the one before it",
    );
    expect(
      formatReport({
        gatewayId: "udp",
        update: {
          status: "written",
          version: "0004",
          changes: ["a: was added"],
        },
        notes: ["b was given a type"],
      }),
    ).toBe(
      [
        "udp: wrote schemas/0004.json",
        "  + a: was added",
        "  notes:",
        "  - b was given a type",
      ].join("\n"),
    );
  });

  it("says a break loudly, with what was kept and what to do", () => {
    const text = formatReport({
      gatewayId: "udp",
      update: {
        status: "breaking",
        latest: "0003",
        problems: ["a: was removed"],
      },
      notes: [],
    });

    expect(text).toContain("udp: BREAKING CHANGE. Nothing was written");
    expect(text).toContain(
      "schemas/0003.json is still what the gateway is generated from",
    );
    expect(text).toContain("  ! a: was removed");
    expect(text).toContain("takes a gateway of its own, under another id");
  });
});

describe("gateway-schemas", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "gateway-schemas.js");

  it("answers whether the run succeeded, which a break upstream does not", async () => {
    const printed: string[] = [];
    await upstreamSays(FIRST);
    expect(await main(gatewayDir, (text) => printed.push(text))).toBe(true);

    await upstreamSays(thing({ id: { type: "string" } }));
    expect(await main(gatewayDir, (text) => printed.push(text))).toBe(false);
    expect(printed[0]).toContain("derived: wrote schemas/0001.json");
    expect(printed[1]).toContain("BREAKING CHANGE");
  });

  it("reports for the gateway it is run in, and fails the process on a break", async () => {
    await upstreamSays(FIRST);
    const written = await execFile(process.execPath, [bin], {
      cwd: gatewayDir,
    });
    expect(written.stdout).toContain("derived: wrote schemas/0001.json");

    await upstreamSays(thing({ id: { type: "string" } }));
    const broken = await execFile(process.execPath, [bin], {
      cwd: gatewayDir,
    }).catch((error: unknown) => error as { code: number; stdout: string });
    expect(broken).toMatchObject({ code: 1 });
    expect(broken.stdout).toContain("BREAKING CHANGE");
    expect(await versions()).toEqual(["0001.json"]);
  }, 60_000);

  it("says what an error was about without saying it to the terminal", async () => {
    // A version refused for its shape is refused before anything reads its characters, and the
    // diagnostic names the field that caused it, which is the upstream's own name. Printed as
    // it stands, the rejection would be the escape sequence the check exists to keep out.
    await writeFile(
      path.join(gatewayDir, "gateway.config.ts"),
      HAND_MAINTAINED,
    );
    await mkdir(path.join(gatewayDir, SCHEMAS_DIR));
    await writeFile(
      path.join(gatewayDir, SCHEMAS_DIR, "0001.json"),
      JSON.stringify({
        operations: {
          getThing: {
            input: {
              type: "object",
              properties: {
                "\u001b[2Kid": { type: "object", required: ["__proto__"] },
              },
            },
            outcomes: { ok: { type: "object" } },
          },
        },
      }),
    );

    const failed = await execFile(process.execPath, [bin], {
      cwd: gatewayDir,
    }).catch((error: unknown) => error as { code: number; stderr: string });

    expect(failed).toMatchObject({ code: 1 });
    expect(failed.stderr).toContain("U+001B[2Kid");
    expect(failed.stderr).toContain('cannot list "__proto__"');
    // Only the line breaks the message was written on; nothing it was given.
    expect(failed.stderr.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  }, 60_000);
});
