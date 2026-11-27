import { printable } from "./printable.ts";

/**
 * A whole message, keeping the lines it was written on and escaping everything else that does not
 * display: an error says several things at once, and reading them is easier than reading what
 * they escape to.
 */
export const printableText = (text: string): string =>
  text.split("\n").map(printable).join("\n");
