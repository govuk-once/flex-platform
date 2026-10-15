import { defineConfig } from "eslint/config";

import { base } from "./base.ts";

// Drivers own transport access. Wrapping upstream calls in ctx.upstream is a contributor
// requirement; this preset does not enforce that wrapping.
export const driver = defineConfig(...base);
