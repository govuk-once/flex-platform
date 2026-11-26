// A request's parameters as the parameter reader takes them, and its body as the route's schema
// takes it. Nothing here throws: what cannot be read is answered as the request's mistake.

import { isRecord } from "@repo/utils/is-record";

import type { SentParameters } from "./parameter-reader.ts";

/** Each query parameter by name: one value as a string, a repeated one as a list. */
export function queryParameters(search: URLSearchParams): SentParameters {
  const sent = new Map<string, string | readonly string[]>();

  for (const [name, value] of search) {
    const held = sent.get(name);

    sent.set(name, held === undefined ? value : [held, value].flat());
  }

  return sent;
}

/**
 * The path parameters the matcher found, each decoded once. Undefined when one does not decode,
 * or decodes to text holding a "/", which would name a path of its own.
 */
export function pathParameters(
  params: ReadonlyMap<string, string>,
): SentParameters | undefined {
  const decoded = new Map<string, string>();

  for (const [name, raw] of params) {
    let value: string;

    try {
      value = decodeURIComponent(raw);
    } catch {
      return undefined;
    }

    if (value.includes("/")) return undefined;

    decoded.set(name, value);
  }

  return decoded;
}

export type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

// Deep enough for any body a route declares. A recursive schema walks a value as deep as it is
// nested, and one nested far enough throws, which would be answered as the schema's failure rather
// than the request's mistake.
const MAX_DEPTH = 64;

// Whether no object or array in the text is nested deeper than `MAX_DEPTH`. Read before the text
// is parsed, so nothing walks a value deeper than that. A bracket inside a string is not counted.
function withinDepth(text: string): boolean {
  let depth = 0;

  let inString = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;

      if (depth > MAX_DEPTH) return false;
    } else if (char === "}" || char === "]") {
      depth--;
    }
  }

  return true;
}

// Every object is parsed without a prototype, so a schema finds a field only where the request
// set it, never one such as `toString` that every object inherits. A `__proto__` key is refused at
// any depth: a schema can pass one on inside a field it does not inspect, and code that copies it
// onto an ordinary object sets that object's prototype.
export function parseJson(text: string): ParsedJson {
  if (!withinDepth(text)) return { ok: false, reason: "nested too deeply" };

  let holdsProto = false;

  let value: unknown;

  try {
    value = JSON.parse(text, (key, held: unknown) => {
      if (key === "__proto__") holdsProto = true;

      if (!isRecord(held)) return held;

      const copy = { ...held };

      Object.setPrototypeOf(copy, null);

      return copy;
    });
  } catch {
    return { ok: false, reason: "malformed JSON" };
  }

  if (holdsProto) return { ok: false, reason: "holds a __proto__ key" };

  return { ok: true, value };
}
