// One log line, in the one shape every function the platform runs writes: a level, the message
// `telemetry`, and an event with its details. A metric filter or a query can then count each event
// by name, whichever function wrote it. The event is one of the function's own fixed names, and
// the details are values the platform derived, never text from a request.
export function logTelemetry(
  level: "INFO" | "ERROR",
  event: string,
  details: object,
): void {
  console.log(
    JSON.stringify({
      level: level,
      message: "telemetry",
      telemetry: { event: event, details: details },
    }),
  );
}
