#!/usr/bin/env node
// Registers tsx before loading the CLI, so it and the gateway configurations it loads can use
// any TypeScript syntax rather than the subset Node strips on its own.
import "tsx";

await import("../src/cli.ts");
