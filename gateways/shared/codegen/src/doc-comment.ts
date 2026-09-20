import { isRecord } from "@repo/utils/is-record";

// What a schema says about itself, as the comment a caller's editor shows beside a type or a
// field. The text is not ours: a schema derived from an upstream's own description of itself
// carries whatever that document said, and it is written into source code a caller compiles.
// Three things could make text act as something other than text, and each is closed here.
//
// Ending the comment: "*/" anywhere in it would hand the rest of the description to the
// compiler as code. Writing a tag: an "@" anywhere in the text opens a JSDoc tag, not only at
// the start of a line where a reader would expect one, so an upstream could mark a field
// deprecated or internal that is neither. Leaving the comment by a line: every line of the text
// is written as a line of one block comment, so none can. Characters that do not display are
// refused when a version is read, so nothing reaching this can show a reviewer one thing and
// hold another. The tags this writes are its own, from what a schema declares rather than from
// what it says.

export interface Documented {
  readonly description?: string;
  readonly deprecated?: boolean;
}

// What a schema offers to document itself with. `title` is used only where there is no
// description: written for a form label, it says less.
export function documentationOf(schema: unknown): Documented {
  if (!isRecord(schema)) return {};
  const text =
    typeof schema.description === "string" && schema.description.trim() !== ""
      ? schema.description
      : typeof schema.title === "string" && schema.title.trim() !== ""
        ? schema.title
        : undefined;
  return {
    ...(text === undefined ? {} : { description: text }),
    ...(schema.deprecated === true ? { deprecated: true } : {}),
  };
}

// The two sequences a description must not carry into the source, written so that neither is
// there to read. A tag is opened by an "@" wherever it stands: "a @internal b" marks the
// declaration internal as surely as a line of its own would, and a "*" in front of one is read
// past. A backslash is not enough either. It stops the compiler parsing the tag, but
// `stripInternal` reads "@internal" out of the comment text whatever precedes it, and a contract
// emitted that way loses the declaration while what referred to it stays: a `.d.ts` naming a
// type it no longer declares. Written as a character reference there is no "@" left to find, and
// an editor rendering the comment as markdown shows one.
function escapeLine(line: string): string {
  return line.replaceAll("*/", "*\\/").replaceAll("@", "&#64;");
}

// The comment, on lines of its own so it can be written straight in front of a declaration, or
// nothing when there is nothing to say. The lines are not layout: the compiler reads a comment
// that shares a line with the token before it as trailing that token, and would attach this one
// to nothing.
export function docComment({ description, deprecated }: Documented): string {
  const lines =
    description === undefined
      ? []
      : description
          .split(/\r\n|\r|\n/)
          .map((line) => escapeLine(line.trimEnd()));
  // Blank lines at either end are layout in the source document, not part of what it says.
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  if (deprecated === true) lines.push("@deprecated");
  if (lines.length === 0) return "";
  if (lines.length === 1) return `\n/** ${lines[0] ?? ""} */\n`;
  return `\n/**\n${lines.map((line) => (line === "" ? " *" : ` * ${line}`)).join("\n")}\n */\n`;
}
