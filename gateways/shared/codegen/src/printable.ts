// Text on its way to a terminal. What these commands print carries an upstream's own words: a
// field name reaches a diagnostic through the schema that declared it, and a driver's notes
// through its derivation, and neither has been through the check a version on disk goes through
// — a version refused for its shape is refused before anything looks at its characters. A
// terminal acts on an escape sequence in what it is given, so text carrying one could move the
// cursor back over the lines above and rewrite what was said there. Written as their code points,
// they say what was there and do nothing.

const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const codePoint = (found: string): string =>
  `U+${(found.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

// One line, with every character that does not display written out, the line breaks a caller
// would lay text out with included: a note that carried one would break the list holding it.
export const printable = (line: string): string =>
  line.replaceAll(HIDDEN, codePoint);

// A whole message, keeping the lines it was written on and nothing else: an error says several
// things at once, and reading them is easier than reading what they escape to.
export const printableText = (text: string): string =>
  text.split("\n").map(printable).join("\n");
