// A request's parameters as the parameter reader takes them, and its body as the route's schema
// takes it. Nothing here throws: what cannot be read is answered as the request's mistake.

import type { SentParameters } from "./parameter-reader.ts";

/** Each query parameter by name: one value as a string, a repeated one as a list. */
export function queryParameters(search: URLSearchParams): SentParameters {
  const sent = new Map<string, string | readonly string[]>();

  for (const name of new Set(search.keys())) {
    const [first = "", ...rest] = search.getAll(name);

    sent.set(name, rest.length === 0 ? first : [first, ...rest]);
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
  { readonly ok: true; readonly value: unknown } | { readonly ok: false };

// The value is checked by the route's schema before a handler sees it. A key such as `__proto__`
// is an own field of the parsed value, which a strict object refuses.
export function parseJson(text: string): ParsedJson {
  try {
    const value: unknown = JSON.parse(text);

    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}
