// What a handler returned, turned into its response: a status its route declares, with a body its
// schema takes, or a server error with no body. The body sent is the schema's output, so a field
// the schema does not declare never leaves. Anything else is a mistake in the handler, which the
// SDK answers for.
//
// A problem is written as `<field>: <problem>, <fix>`, as checkDomain writes one. It names no
// value from the result but its status, since a body can hold a caller's data. A response schema
// that throws is the schema's failure, not the handler's, and is kept apart.

import { isRecord } from "@repo/utils/is-record";
import type { ZodType } from "zod";

import type { ServerErrorStatusCode } from "../http.ts";
import { SERVER_ERROR_STATUS_CODES } from "../http.ts";
import { jsonResponse, platformErrorResponse } from "./responses.ts";
import { runSchema } from "./run-schema.ts";

// A Map, since the status comes from the handler at request time.
export type ResponseSchemas = ReadonlyMap<number, ZodType | null>;

export type CheckedResult =
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly serverError: boolean;
    }
  | { readonly kind: "problem"; readonly problem: string }
  | { readonly kind: "failed"; readonly error: unknown };

const RESULT_FIELDS: ReadonlySet<string> = new Set(["status", "body"]);

const SERVER_ERRORS: ReadonlySet<number> = new Set(SERVER_ERROR_STATUS_CODES);

function isServerError(status: number): status is ServerErrorStatusCode {
  return SERVER_ERRORS.has(status);
}

export function responseSchemas(
  responses: Readonly<Record<string, ZodType | null | undefined>>,
): ResponseSchemas {
  return new Map(
    Object.entries(responses).map(([status, schema]) => [
      Number(status),
      schema ?? null,
    ]),
  );
}

function problem(text: string): CheckedResult {
  return { kind: "problem", problem: text };
}

function allowedStatuses(schemas: ResponseSchemas): string {
  return [...schemas.keys(), ...SERVER_ERROR_STATUS_CODES]
    .sort((left, right) => left - right)
    .join(", ");
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

export async function responseFor(
  schemas: ResponseSchemas,
  result: unknown,
): Promise<CheckedResult> {
  if (!isRecord(result)) {
    return problem(
      "result: invalid type, must be an object of status and body",
    );
  }

  // Any other field would be dropped without a word, such as headers a handler expects to be sent.
  // Its name is not written, as a handler may build one from a request.
  if (Object.keys(result).some((field) => !RESULT_FIELDS.has(field))) {
    return problem(
      `result: unknown field, must be one of: ${[...RESULT_FIELDS].join(", ")}`,
    );
  }

  const { status, body } = result;

  if (typeof status !== "number") {
    return problem("status: invalid type, must be a number");
  }

  if (isServerError(status)) {
    return body === undefined
      ? {
          kind: "response",
          response: platformErrorResponse(status),
          serverError: true,
        }
      : problem(`body: not allowed, status ${status} is a server error`);
  }

  const schema = schemas.get(status);

  if (schema === undefined) {
    return problem(
      `status: ${status} not declared, must be one of: ${allowedStatuses(schemas)}`,
    );
  }

  if (schema === null) {
    return body === undefined
      ? {
          kind: "response",
          response: new Response(null, { status }),
          serverError: false,
        }
      : problem(`body: not allowed, status ${status} has no body`);
  }

  const checked = await runSchema(schema, body);

  if (checked.kind === "failed") return checked;

  if (checked.kind === "refused") {
    return problem(`body: invalid, must match the schema for status ${status}`);
  }

  const text = toJson(checked.data);

  if (text === undefined) {
    return problem("body: invalid, must be a value JSON can write");
  }

  return {
    kind: "response",
    response: jsonResponse(status, text),
    serverError: false,
  };
}
