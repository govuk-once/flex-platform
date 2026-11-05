import { selectFrameLocations } from "./internal/frame-locations.ts";

export interface UnexpectedErrorSummary {
  readonly frames: readonly string[];
}

type StackFormatter = (error: Error, callSites: NodeJS.CallSite[]) => unknown;

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
    void target.stack; // NOSONAR: reading it is what runs the hook
  } finally {
    Object.defineProperty(Error, "prepareStackTrace", descriptor);
  }
  return frames ?? [];
}

// What to log for an error nothing declared: where it was created, and nothing else.
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
