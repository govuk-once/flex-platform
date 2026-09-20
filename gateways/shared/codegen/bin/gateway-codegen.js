#!/usr/bin/env node
// Registers tsx before loading the CLI, so it and the gateway configurations it loads can use
// any TypeScript syntax rather than the subset Node strips on its own. Everything the command
// does is in src/cli.ts; what is here is the process: its working directory and its exit code.
import "tsx";

// Loaded first, so that whatever the CLI turns out to say is said safely: an error
// names the schema that caused it, which is an upstream's own text.
const { printableText } = await import("../src/printable.ts");
const { main } = await import("../src/cli.ts");

try {
  await main(process.cwd());
} catch (error) {
  console.error(
    printableText(error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
}
