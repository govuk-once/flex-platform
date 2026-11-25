import type { PairwiseId, PushId } from "./caller.ts";
import type { Problem } from "./types.ts";

/** What a handler may put in a log line beside its message: scalars only. */
export type LogFields = Readonly<
  Record<string, string | number | boolean | null>
>;

// The caller's IDs are personal data, and nothing in the platform logs them.
type PersonalId = PairwiseId | PushId;

type PersonalIdProblem =
  Problem<"pairwiseId and pushId are personal data, never log them">;

// A message is fixed text, so nothing from a request can be written into it. Text built from a
// template or a variable is typed `string`, and refused.
type FixedText<Message extends string> = string extends Message
  ? Problem<"message must be a string literal, pass values as fields">
  : Message extends PersonalId
    ? PersonalIdProblem
    : unknown;

type PersonalIdFields<Fields> = {
  readonly [
    Field in keyof Fields as Fields[Field] extends PersonalId ? Field : never
  ]: PersonalIdProblem;
};

/**
 * A handler's own log lines, written beside the SDK's line for the request, with its trace ID and
 * route. The SDK replaces any field that holds the caller's token or IDs, whatever its type.
 *
 * ```ts
 * log.info("todo not found", { attempt: 2 });
 * ```
 */
export interface Log {
  info<Message extends string, Fields extends LogFields = Record<never, never>>(
    message: Message & FixedText<Message>,
    fields?: Fields & PersonalIdFields<Fields>,
  ): void;
  warn<Message extends string, Fields extends LogFields = Record<never, never>>(
    message: Message & FixedText<Message>,
    fields?: Fields & PersonalIdFields<Fields>,
  ): void;
}
