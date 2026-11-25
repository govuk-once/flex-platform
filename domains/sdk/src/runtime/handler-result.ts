// What a handler answered, turned into its response: a status its route declares, with a body its
// schema takes, or a server error with no body. The body sent is the schema's output, so a field
// the schema does not declare never leaves. Anything else is a mistake in the handler, which the
// SDK answers for.

import { isRecord } from "@repo/utils/is-record";
import type { ZodType } from "zod";

import type { ServerErrorStatusCode } from "../http.ts";
import { SERVER_ERROR_STATUS_CODES } from "../http.ts";
import { jsonResponse, platformErrorResponse } from "./responses.ts";

// A Map, since the status comes from the handler at request time.
export type ResultRules = ReadonlyMap<number, ZodType | null>;

export type ResultAnswer =
  | {
      readonly ok: true;
      readonly response: Response;
      // The body as sent, for the route's `log` to pick from.
      readonly output?: unknown;
      readonly serverError: boolean;
    }
  | { readonly ok: false; readonly problem: string };

const SERVER_ERRORS: ReadonlySet<number> = new Set(SERVER_ERROR_STATUS_CODES);

function isServerError(status: number): status is ServerErrorStatusCode {
  return SERVER_ERRORS.has(status);
}

export function resultRules(
  responses: Readonly<Record<string, ZodType | null | undefined>>,
): ResultRules {
  return new Map(
    Object.entries(responses).map(([status, schema]) => [
      Number(status),
      schema ?? null,
    ]),
  );
}

function problem(text: string): ResultAnswer {
  return { ok: false, problem: text };
}

// The body's text, or undefined for a value JSON cannot write, such as a BigInt or an object that
// holds itself.
function toJson(value: unknown): string | undefined {
  try {
    const text: unknown = JSON.stringify(value);

    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

export function answerResult(
  rules: ResultRules,
  result: unknown,
): ResultAnswer {
  if (!isRecord(result)) {
    return problem("the handler answered with something other than a result");
  }

  const { status, body } = result;

  if (typeof status === "number" && isServerError(status)) {
    return body === undefined
      ? { ok: true, response: platformErrorResponse(status), serverError: true }
      : problem("the handler answered a server error with a body");
  }

  const schema = typeof status === "number" ? rules.get(status) : undefined;

  if (typeof status !== "number" || schema === undefined) {
    return problem(
      "the handler answered with a status its route does not declare",
    );
  }

  if (schema === null) {
    return body === undefined
      ? {
          ok: true,
          response: new Response(null, { status }),
          serverError: false,
        }
      : problem("the handler answered with a body for a status that has none");
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return problem("the handler's body does not match its status's schema");
  }

  const text = toJson(parsed.data);

  return text === undefined
    ? problem("the handler's body cannot be written as JSON")
    : {
        ok: true,
        response: jsonResponse(status, text),
        output: parsed.data,
        serverError: false,
      };
}
