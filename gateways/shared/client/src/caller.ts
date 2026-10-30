// The SDK's entry point, which runs a domain's handler with its caller context. Kept out of the
// main entry, so a domain developer's editor does not offer it.

export type { CallerContext, SecureContext } from "./context.ts";
export { withCallerContext } from "./context.ts";
