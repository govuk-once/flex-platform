import { formatReport, updateSchemas } from "./update-schemas.ts";

// What the command does in a gateway package: bring the schemas of the gateway in the given
// directory up to date, and say what happened. Answers whether the run succeeded, which a break
// upstream does not: the process is the bin script's, and the exit code with it.
export async function main(
  gatewayDir: string = process.cwd(),
  print: (text: string) => void = console.log,
): Promise<boolean> {
  const report = await updateSchemas(gatewayDir);
  print(formatReport(report));
  return report.update.status !== "breaking";
}
