#!/usr/bin/env node
// Registers tsx before loading the CLI, as codegen's commands do. Everything the command does is
// in src/cli.ts; what is here is the process: its working directory, its output and its exit
// code.
import "tsx";

const { main } = await import("../src/cli.ts");

try {
  console.log(await main(process.cwd(), process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
