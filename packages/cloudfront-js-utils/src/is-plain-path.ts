// CloudFront hands a function the path as the caller sent it, still percent-encoded. Anything a
// router might read as a different path is refused before any later step reads it.
const UNSAFE = /%2f|%5c|%2e|\\/i;

// Whether a path is a slash followed by segments, each of them something: no empty segment, so no
// doubled or trailing slash, no `.` or `..`, no backslash, and no slash, backslash or dot written
// as a percent-encoding.
export function isPlainPath(uri: string): boolean {
  if (UNSAFE.test(uri)) return false;

  const segments = uri.split("/");
  // Text before the first slash, or no slash at all.
  if (segments[0] !== "" || segments.length < 2) return false;

  // An index loop: the runtime has no for...of.
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}
