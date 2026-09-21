import { type PathPart, pathParts } from "../upstream.ts";

// Which of a document's path templates serves a path the document does not declare itself, and
// what of the template the path fills in. An upstream behind a gateway of its own routes a
// request to the most specific template that fits it: a segment written out beats a parameter,
// and a parameter beats one that takes every segment that is left, "{name+}". Deriving has to
// agree with that, or an operation's schemas would describe a request some other endpoint
// answers.

export type Segment =
  // Text, with no parameter in it.
  | { readonly kind: "literal"; readonly text: string }
  // The whole segment, and nothing else.
  | { readonly kind: "parameter"; readonly name: string }
  // The whole of what is left, "{name+}".
  | { readonly kind: "greedy"; readonly name: string }
  // A parameter sharing its segment with text, "{id}.json", which a request substitutes into
  // and this does not fit a path through. Read as text it would be a literal that no value
  // could ever produce, and a path that reaches another endpoint through it would go unseen.
  | { readonly kind: "mixed"; readonly parts: readonly PathPart[] };

// Read with what builds a request, so the two agree on where a parameter is.
export function segmentsOf(template: string): readonly Segment[] {
  return template
    .split("/")
    .slice(1)
    .map((text): Segment => {
      const parts = pathParts(text);
      const [only, ...rest] = parts;
      if (only === undefined) return { kind: "literal", text };
      if (rest.length === 0 && only.kind === "literal") {
        return { kind: "literal", text };
      }
      if (rest.length === 0 && only.kind === "param") {
        return only.name.endsWith("+")
          ? { kind: "greedy", name: only.name.slice(0, -1) }
          : { kind: "parameter", name: only.name };
      }
      return { kind: "mixed", parts };
    });
}

// Text as a segment reads, or undefined where it cannot be read as one.
function read(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

// Whether two pieces of a path are the same segment. A template writes its text as it goes into
// a URL and a path may be written as the text it stands for — "é" and "%C3%A9" are one segment,
// and so are "admin panel" and "admin%20panel" — so both are read before they are compared. One
// that cannot be read as a segment at all counts as the same, since nothing here has told them
// apart, and it is telling them apart that a check would go on.
function sameText(left: string, right: string): boolean {
  if (left === right) return true;
  const one = read(left);
  const other = read(right);
  return one === undefined || other === undefined || one === other;
}

// Whether text could be what a segment of parameters and text came to: the text it is written
// with has to be there, in the order it is written in, read as a segment the same way.
function mixedCouldBe(parts: readonly PathPart[], text: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    return true;
  }
  const literals = parts.map((part) =>
    part.kind === "literal" ? read(part.value) : undefined,
  );
  if (
    literals.some(
      (value, index) => parts[index]?.kind === "literal" && value === undefined,
    )
  ) {
    return true;
  }

  let at = 0;
  for (const [index, value] of literals.entries()) {
    if (value === undefined) continue;
    if (index === 0) {
      if (!decoded.startsWith(value)) return false;
      at = value.length;
      continue;
    }
    if (index === literals.length - 1) {
      return decoded.endsWith(value) && decoded.length - value.length >= at;
    }
    const found = decoded.indexOf(value, at);
    if (found < 0) return false;
    at = found + value.length;
  }
  return true;
}

export interface Fit {
  // A template parameter the path fills with text of its own, so no caller supplies it.
  readonly fixed: ReadonlyMap<string, string>;
  // A template parameter the path leaves as a parameter, by the path's own name for it.
  readonly carried: ReadonlyMap<string, string>;
}

// A slash or a backslash written into a segment as an escape, or a backslash as it is: a router
// that decodes one, or reads a backslash as a slash as a URL parser does, sees a segment more
// than the path is written with.
const SEPARATOR = /%2F|%5C|\\/i;

// Where a path is not the segments it is written as to every router that could route it: an
// empty one, which a router may drop or merge with the next, and a separator written inside one.
// "/v1/sar/abc/" fits "/v1/{resourcePath+}" as written, and reaches "/v1/sar/{sarId}" through
// one that ignores a trailing slash.
function ambiguity(path: string): string | undefined {
  for (const [index, text] of path.split("/").slice(1).entries()) {
    const at = `its segment ${String(index + 1)}`;
    if (text === "") {
      return `${at} is empty, which a router may drop or merge with the next`;
    }
    if (SEPARATOR.test(text)) {
      return `${at} writes a slash or a backslash inside it, which a router may read as a separator`;
    }
  }
  return undefined;
}

// How a path fits a template, or why it does not.
export function fit(path: string, template: string): Fit | string {
  const ambiguous = ambiguity(path);
  if (ambiguous !== undefined) return ambiguous;
  const asked = segmentsOf(path);
  const offered = segmentsOf(template);
  const fixed = new Map<string, string>();
  const carried = new Map<string, string>();

  for (const [index, segment] of offered.entries()) {
    if (segment.kind === "greedy") {
      if (index !== offered.length - 1) {
        return `"{${segment.name}+}" takes every segment that is left, so it can only come last`;
      }
      const rest = asked.slice(index);
      if (rest.length === 0)
        return "it has no segment for the template's last parameter";
      const texts: string[] = [];
      for (const part of rest) {
        // A parameter of the path's own here would be a caller choosing where under the
        // template a request goes, which is what naming the path in full is there to prevent.
        if (part.kind !== "literal") {
          const named =
            part.kind === "mixed" ? "a parameter" : `"{${part.name}}"`;
          return `what "{${segment.name}+}" takes has to be written out, and ${named} is a parameter`;
        }
        texts.push(part.text);
      }
      fixed.set(segment.name, texts.join("/"));
      return { fixed, carried };
    }

    const part = asked[index];
    if (part === undefined) return "it has fewer segments than the template";
    // A parameter sharing a segment with text is a form this does not work out: what of it the
    // path fills, and what it keeps, is not one thing or the other.
    if (segment.kind === "mixed" || part.kind === "mixed") {
      return "a parameter that shares its segment with text is not one this fits a path through";
    }
    if (segment.kind === "literal") {
      if (part.kind !== "literal" || part.text !== segment.text) {
        return `its segment ${String(index + 1)} is not "${segment.text}"`;
      }
    } else if (part.kind === "literal") {
      fixed.set(segment.name, part.text);
    } else {
      carried.set(segment.name, part.name);
    }
  }

  return asked.length > offered.length
    ? "it has more segments than the template"
    : { fixed, carried };
}

// Whether some value of a path's own parameters would produce a path the template takes. A
// segment the template writes out is reached by a parameter of the path unless something says
// that parameter cannot be that text: the upstream routes on the value a caller sends, not on
// the template it was written under, so a parameter that can be "admin" reaches whatever
// "admin" is routed to.
export function couldReach(
  path: string,
  template: string,
  excludes: (index: number, text: string) => boolean,
): boolean {
  const asked = segmentsOf(path);
  const offered = segmentsOf(template);
  const greedy = offered.at(-1)?.kind === "greedy";
  if (
    greedy ? asked.length < offered.length : asked.length !== offered.length
  ) {
    return false;
  }
  for (const [index, segment] of offered.entries()) {
    const part = asked[index];
    // A parameter sharing its segment with text takes only what has that text around it:
    // "notifications" is not "{file}.json". What a parameter of the path's own could come to
    // is not something a list of values says of the text around it, so that is taken to fit.
    if (segment.kind === "mixed") {
      if (part?.kind === "literal" && !mixedCouldBe(segment.parts, part.text)) {
        return false;
      }
      continue;
    }
    // A parameter of the template takes whatever reaches it.
    if (segment.kind !== "literal") continue;
    if (part === undefined) return false;
    if (part.kind === "literal") {
      if (!sameText(part.text, segment.text)) return false;
    } else if (part.kind === "mixed") {
      // What the parameters in it could come to is not what a list of values says of one of
      // them, so nothing here proves the segment cannot be the template's text.
      if (!mixedCouldBe(part.parts, segment.text)) return false;
    } else if (excludes(index, segment.text)) {
      return false;
    }
  }
  return true;
}

// A segment written out is routed to before one with a parameter in it, and one that is only a
// parameter before one that takes everything left.
const RANK = { literal: 4, mixed: 3, parameter: 2, greedy: 1 } as const;

// Whether one template is routed to before another, for a path both fit: the first segment
// they differ in kind at decides.
export function isMoreSpecific(template: string, than: string): boolean {
  const left = segmentsOf(template);
  const right = segmentsOf(than);
  for (const [index, segment] of left.entries()) {
    const other = right[index];
    if (other === undefined) return true;
    if (RANK[segment.kind] !== RANK[other.kind]) {
      return RANK[segment.kind] > RANK[other.kind];
    }
  }
  return false;
}
