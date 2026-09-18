import { generate } from "./generate.ts";

// What the command does in a gateway package: generate from the gateway in the given directory,
// which is the working directory when the bin script runs it. Exported and free of side effects,
// so the command is exercised here rather than only as a process; the process itself, which is
// the exit code and nothing else, is the bin script.
export async function main(gatewayDir: string = process.cwd()): Promise<void> {
  await generate(gatewayDir);
}
