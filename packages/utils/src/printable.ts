// Text on its way to a terminal, which can carry another's words: an upstream's field names, a
// domain's answer, a path from the command line. A terminal acts on an escape sequence in what it
// is given, so text carrying one could move the cursor back over the lines above and rewrite what
// was said there, and a line break could fake a line of output. Written as their code points,
// they say what was there and do nothing.

const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const codePoint = (found: string): string =>
  `U+${(found.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * One line, with every character that does not display written out, the line breaks a caller
 * would lay text out with included: a note that carried one would break the list holding it.
 */
export const printable = (line: string): string =>
  line.replaceAll(HIDDEN, codePoint);
