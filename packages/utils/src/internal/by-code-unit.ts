// One order for everything that has to come out the same twice: generated files, the digests
// taken over them, and a canonical payload built from a record. Strings compare by UTF-16 code
// unit, which is a total order that is the same on every machine.
//
// `String.localeCompare` is what a linter will suggest for sorting "alphabetically", and it is
// the wrong tool here twice over: the order it gives depends on the locale and on the ICU data
// the runtime was built with, so two machines can order the same names differently; and it can
// call distinct strings equal, which leaves them in insertion order, since a sort is stable.
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
