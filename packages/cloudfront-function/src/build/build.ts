import { parse } from "acorn";
import { buildSync } from "esbuild";

// CloudFront refuses a function larger than this.
const MAX_FUNCTION_BYTES = 10 * 1024;

const EXPORT_STATEMENT = /export\s*\{\s*handler\s*\};?\s*$/;

export interface CloudFrontFunctionBuild {
  /** The module that exports `handler`, by its path. */
  readonly entry: string;
  /**
   * What the build writes in place of each of these identifiers, as JSON, such as a function's
   * config. The function then needs nothing at runtime.
   */
  readonly define: Readonly<Record<string, unknown>>;
}

// Synchronous, because CDK builds constructs synchronously.
export function buildCloudFrontFunction({
  entry,
  define,
}: CloudFrontFunctionBuild): string {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(define)) {
    defined[name] = JSON.stringify(value);
  }

  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    // The cloudfront-js-2.0 runtime is ES5.1 with these later features. esbuild rewrites
    // everything else, and fails on anything it can't.
    target: "es5",
    supported: {
      arrow: true,
      "async-await": true,
      "const-and-let": true,
      "exponent-operator": true,
      "regexp-named-capture-groups": true,
      "rest-argument": true,
      "template-literal": true,
    },
    external: ["crypto"],
    define: defined,
    legalComments: "none",
    // Identifiers stay as written, so the runtime still finds handler by name.
    minifyWhitespace: true,
    minifySyntax: true,
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error("esbuild produced no output");
  return toRuntimeCode(output);
}

// Turns esbuild's module into what the runtime runs: a script with a top-level handler.
export function toRuntimeCode(output: string): string {
  // The runtime refuses an export statement.
  if (!EXPORT_STATEMENT.test(output)) {
    throw new Error("The bundle doesn't end by exporting handler");
  }
  const code = output.replace(EXPORT_STATEMENT, "").trim();
  if (!declaresTopLevelHandler(code)) {
    throw new Error("The bundle doesn't declare `function handler(`");
  }

  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes > MAX_FUNCTION_BYTES) {
    throw new Error(
      `The function is ${bytes} bytes; CloudFront allows ${MAX_FUNCTION_BYTES}`,
    );
  }
  return code;
}

// The runtime finds the handler by a function declaration at the top of the script, never an arrow
// function or a nested declaration. Only a parser can see which scope a declaration is in.
function declaresTopLevelHandler(code: string): boolean {
  const program = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  return program.body.some(
    (statement) =>
      statement.type === "FunctionDeclaration" &&
      statement.id.name === "handler",
  );
}
