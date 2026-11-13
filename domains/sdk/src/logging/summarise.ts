// What is logged for an error: where it was created, and nothing it says. Its message, name,
// properties, cause and stack text can each hold a payload.
//
// An error is summarised wherever the redactor meets one, and again by the logger for whatever
// is under `err` or `error`. The second pass would read the first's summary as something that
// is not an error and empty it, so a summary made here is remembered and returned as it is.
// An error's frames can be read only once, so its summary is remembered too: a handler that
// logs an error and then lets it out has it logged twice, with the same frames.

import type { UnexpectedErrorSummary } from "@repo/utils/describe-unexpected-error";
import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

const summaries = new WeakSet<object>();
const byError = new WeakMap<object, UnexpectedErrorSummary>();

export function isSummary(value: object): value is UnexpectedErrorSummary {
  return summaries.has(value);
}

export function summarise(value: unknown): UnexpectedErrorSummary {
  const held = typeof value === "object" && value !== null ? value : undefined;
  if (held !== undefined && isSummary(held)) return held;
  const known = held === undefined ? undefined : byError.get(held);
  if (known !== undefined) return known;
  const summary = describeUnexpectedError(value);
  summaries.add(summary);
  if (held !== undefined) byError.set(held, summary);
  return summary;
}
