// A value JSON carries as itself: a string, a boolean, or a number that survives the round trip.
// `NaN` and the infinities do not — JSON has no notation for them and they serialise as null —
// so a caller that accepted them would send, sign or log something other than what it read.
//
// `null` is not included, because what it means is the caller's to decide: a field that may be
// null says so with `value === null ||`, where one that treats it as absent leaves it out.
export function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
