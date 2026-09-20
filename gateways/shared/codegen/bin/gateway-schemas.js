#!/usr/bin/env node
// Registers tsx before loading the CLI, so it, the gateway configuration it loads and the module
// a driver derives its schemas with can use any TypeScript syntax. Everything the command does
// is in src/schemas-cli.ts; what is here is the process: its working directory and its exit
// code, which is a failure for a change upstream that breaks a caller as well as for an error.
import "tsx";

// Loaded first, so that whatever the CLI turns out to say is said safely: an error
// names the schema that caused it, which is an upstream's own text.
const { printableText } = await import("../src/printable.ts");
const { main } = await import("../src/schemas-cli.ts");

try {
  if (!(await main(process.cwd()))) process.exit(1);
} catch (error) {
  console.error(
    printableText(error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
}
