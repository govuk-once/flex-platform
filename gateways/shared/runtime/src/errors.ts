import type { ErrorCode } from "@repo/gateway-types";

// A deliberate diagnostic. Its message is written to be logged; the runtime records it as is.
export class GatewayError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

export interface UnexpectedErrorSummary {
  readonly frames: readonly string[];
}

const MAX_FRAMES = 10;
const MAX_INSPECTED = 50;
const MAX_FILENAME_LENGTH = 1024;

// The call-site methods read here. Nothing else on a call site, the function name included, is
// consulted.
export type CallSiteLocation = Pick<
  NodeJS.CallSite,
  "isEval" | "getFileName" | "getLineNumber" | "getColumnNumber"
>;

type StackFormatter = (error: Error, callSites: NodeJS.CallSite[]) => unknown;

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// A filesystem path, a local file URL or a Node internal: the places deployed code is loaded
// from. Anything else, a data: or http: URL say, is not a source location, and a URL's query or
// fragment is not part of one.
function isSourceLocation(filename: string): boolean {
  if (filename.length === 0 || filename.length > MAX_FILENAME_LENGTH) {
    return false;
  }
  if (filename.startsWith("node:")) return true;
  if (filename.startsWith("file:")) {
    let url: URL;
    try {
      url = new URL(filename);
    } catch {
      return false;
    }
    return url.host === "" && url.search === "" && url.hash === "";
  }
  return filename.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filename);
}

// Builds "at file:line:column" from V8's structured frames and nothing else. The values are
// checked as unknown rather than trusted to their declared types: a filename is deployment
// metadata only once it is known to be one. Exported for its tests, since only V8 can produce
// real call sites.
export function selectFrameLocations(
  callSites: readonly CallSiteLocation[],
): string[] {
  const frames: string[] = [];
  const limit = Math.min(callSites.length, MAX_INSPECTED);
  for (let i = 0; i < limit && frames.length < MAX_FRAMES; i += 1) {
    const site = callSites[i];
    if (site === undefined || site.isEval()) continue;
    const filename: unknown = site.getFileName();
    const line: unknown = site.getLineNumber();
    const column: unknown = site.getColumnNumber();
    if (typeof filename !== "string" || !isSourceLocation(filename)) continue;
    if (!isCoordinate(line) || !isCoordinate(column)) continue;
    frames.push(`at ${filename}:${line}:${column}`);
  }
  return frames;
}

// Reads V8's structured frames for one error by formatting its stack under a temporary
// Error.prepareStackTrace that records the locations for that error alone and then delegates
// to the formatter already installed, so the stack ends up exactly as it would have anyway.
// Nothing is read from the resulting string. V8 formats a stack once, so an error whose stack
// was already read, or replaced, yields nothing. Installed and restored synchronously; without
// a usable formatter to delegate to, nothing is installed.
function captureFrames(target: Error): string[] {
  const descriptor = Object.getOwnPropertyDescriptor(
    Error,
    "prepareStackTrace",
  );
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    return [];
  }
  const previous = descriptor.value as StackFormatter;
  let frames: string[] | undefined;
  const hook: StackFormatter = (error, callSites) => {
    if (error === target && frames === undefined) {
      frames = selectFrameLocations(callSites);
    }
    return previous.call(Error, error, callSites);
  };
  try {
    Object.defineProperty(Error, "prepareStackTrace", {
      ...descriptor,
      value: hook,
    });
  } catch {
    return [];
  }
  try {
    void target.stack;
  } finally {
    Object.defineProperty(Error, "prepareStackTrace", descriptor);
  }
  return frames ?? [];
}

// What the runtime logs for an error nothing declared: where it was created, and nothing else.
// The message, name, properties, cause and stack text can all carry a payload, so none of them
// is copied. Total by construction: a throwing getter or formatter yields an empty list.
export function describeUnexpectedError(err: unknown): UnexpectedErrorSummary {
  try {
    if (Error.isError(err)) {
      return { frames: captureFrames(err) };
    }
  } catch {
    // A throwing getter or formatter says nothing safe about the error either.
  }
  return { frames: [] };
}
