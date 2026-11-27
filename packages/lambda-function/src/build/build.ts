import { buildSync } from "esbuild";

/** Every bundle is CommonJS, deployed as `index.js` with this handler. */
export const HANDLER = "index.handler";

export interface LambdaFunctionBuild {
  /** The module that exports `handler`, by its path. */
  readonly entry: string;
  /**
   * What the build writes in place of each of these identifiers, as JSON, such as a function's
   * config. The function then needs nothing at runtime.
   */
  readonly define: Readonly<Record<string, unknown>>;
}

// Synchronous, because CDK builds constructs synchronously. Returns the code of `index.js`, with
// every dependency bundled, the AWS SDK's included, so the function runs the versions tested
// here.
export function buildLambdaFunction({
  entry,
  define,
}: LambdaFunctionBuild): string {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(define)) {
    defined[name] = JSON.stringify(value);
  }

  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node26",
    define: defined,
    // Not minified, so the source locations a failure logs point at a line worth reading.
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error("esbuild produced no output");
  return output;
}
