import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { DeriveSchemas } from "@repo/gateway-config";

// The module a definition gives as the one that derives its schemas, loaded. A definition gives
// it as a `file:` URL it builds from its own, `new URL("../derive/index.ts", import.meta.url)`, so
// nothing has to resolve a name: the module is wherever the driver's own files are. Looked for
// before it is loaded, so one that is not there is refused as that rather than as whatever a
// loader makes of a file that is missing.
export async function loadDerive(location: string): Promise<DeriveSchemas> {
  const url = URL.canParse(location) ? new URL(location) : undefined;
  if (url?.protocol !== "file:") {
    throw new Error(
      `The driver gives "${location}" as the module that derives its schemas, which is not a file: URL`,
    );
  }
  try {
    await stat(fileURLToPath(url));
  } catch (cause) {
    throw new Error(
      `The driver gives "${location}" as the module that derives its schemas, which is not there`,
      { cause },
    );
  }
  const module = (await import(url.href)) as { default?: unknown };
  if (typeof module.default !== "function") {
    throw new TypeError(
      `"${location}" must export the function that derives schemas as its default`,
    );
  }
  return module.default as DeriveSchemas;
}
