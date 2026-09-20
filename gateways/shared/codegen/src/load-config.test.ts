import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./load-config.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "load-config-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a gateway configuration written in TypeScript", async () => {
    await writeFile(
      path.join(tmp, "gateway.config.ts"),
      `const id: string = "loaded";\nexport default { id, operations: {} };\n`,
    );

    await expect(loadConfig(tmp)).resolves.toMatchObject({ id: "loaded" });
  });
});
