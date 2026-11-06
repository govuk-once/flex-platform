const MAX_FRAMES = 10;
const MAX_INSPECTED = 50;
const MAX_FILENAME_LENGTH = 1024;

// The call-site methods read here. Nothing else on a call site, the function name included, is
// consulted.
export type CallSiteLocation = Pick<
  NodeJS.CallSite,
  "isEval" | "getFileName" | "getLineNumber" | "getColumnNumber"
>;

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
// metadata only once it is known to be one. Its own module so its tests can reach it, since only
// V8 can produce real call sites.
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
