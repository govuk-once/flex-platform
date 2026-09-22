import type { SecretProvider, Validator } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";

import { isVerbatimHeaderValue, normaliseHeaderName } from "../headers.ts";
import type { HttpMethod, OpenApiRestResponse } from "../types.ts";

// One request an authentication flow makes for itself, a token exchange say. The driver sends
// it inside the operation's attempt, so the attempt's budget bounds it, and maps transport
// failures the same way as an operation's request. Statuses are not mapped: what a token
// endpoint's 401 means is the flow's decision.
export interface OpenApiRestAuthCall {
  readonly method: HttpMethod;
  // An absolute http or https URL, or a path beginning with "/" resolved against the upstream
  // target. An address is deployment configuration, so it usually comes from the secret.
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  // A JSON body, or a form body sent as application/x-www-form-urlencoded. Not both.
  readonly json?: unknown;
  readonly form?: Readonly<Record<string, string>>;
}

// The transport an authentication flow is given. It is the only way such a flow reaches the
// network: cancellation, the response size limit and error replacement all apply.
export interface OpenApiRestAuthTransport {
  request(
    call: OpenApiRestAuthCall,
    signal: AbortSignal,
  ): Promise<OpenApiRestResponse>;
}

export interface OpenApiRestAuthRequest {
  readonly operation: string;
  // The attempt's signal. Pass it to the transport so a request that runs out of budget
  // releases an exchange as well.
  readonly signal: AbortSignal;
}

// Per-executor authentication state. `headers` runs inside every request's attempt and returns
// the headers to apply, whose names must be among those the definition declares.
export interface OpenApiRestAuthInstance {
  headers(
    request: OpenApiRestAuthRequest,
  ): Promise<Readonly<Record<string, string>>>;
}

export interface OpenApiRestAuthDeps<TSecret> {
  // The gateway secret, validated: every value returned here has passed `validateSecret` on
  // that read. Reads are cheap, since the runtime caches the secret for a bounded age, and a
  // read after the age sees a rotated value.
  readonly secret: SecretProvider<TSecret>;
  readonly transport: OpenApiRestAuthTransport;
}

// How a gateway's requests are authenticated. A definition is data: it declares what the secret
// must hold and which headers it sets, and builds its state only when the executor is created,
// so a configuration that names one can be imported without a secret or a network. Additional
// schemes are further definitions, not cases in the driver.
export interface OpenApiRestAuth<TSecret = unknown> {
  // Accepts the parsed secret object. Runs on the initial secret and on every read after it;
  // nothing from a secret reaches `create`d state until it has passed.
  readonly validateSecret: Validator<TSecret>;
  // Header names this implementation sets. Reserved before operations compile: no static
  // header, parameter mapping or handler call may set them, and the instance may set no other.
  readonly headers: readonly string[];
  // Builds the mutable state for one executor. Never performs a retrieval or an exchange
  // itself; those happen when a request's `headers` runs, inside its attempt.
  create(deps: OpenApiRestAuthDeps<TSecret>): OpenApiRestAuthInstance;
}

// Names the secret type once, on the validator, and types `create` from it.
export function defineAuth<TSecret>(
  auth: OpenApiRestAuth<TSecret>,
): OpenApiRestAuth<TSecret> {
  return auth;
}

type ValidationError = NonNullable<Validator["errors"]>[number];

// A validator in the shared convention: a type predicate that leaves its findings on `errors`,
// as a generated one would. The built-in definitions need three shapes, which is not worth a
// schema compiler in the driver; a custom definition may use a generated validator.
function validator<T>(
  check: (data: unknown) => ValidationError[],
): Validator<T> {
  const result: Validator<T> = Object.assign(
    (data: unknown): data is T => {
      const errors = check(data);
      result.errors = errors.length === 0 ? null : errors;
      return errors.length === 0;
    },
    { errors: null as Validator<T>["errors"] },
  );
  return result;
}

// Findings name paths and keywords only: a value never appears, and neither does the name of
// an unexpected field, which is not the validator's to repeat.
function objectWithFields(
  data: unknown,
  fields: readonly string[],
): ValidationError[] {
  if (!isRecord(data)) {
    return [
      { instancePath: "", schemaPath: "#/type", message: "must be object" },
    ];
  }
  const errors: ValidationError[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(data, field)) {
      errors.push({
        instancePath: "",
        schemaPath: "#/required",
        message: `must have required property '${field}'`,
      });
      continue;
    }
    const value = data[field];
    if (typeof value !== "string") {
      errors.push({
        instancePath: `/${field}`,
        schemaPath: `#/properties/${field}/type`,
        message: "must be string",
      });
    } else if (value.length === 0) {
      errors.push({
        instancePath: `/${field}`,
        schemaPath: `#/properties/${field}/minLength`,
        message: "must NOT have fewer than 1 characters",
      });
    } else if (!isVerbatimHeaderValue(value)) {
      errors.push({
        instancePath: `/${field}`,
        schemaPath: `#/properties/${field}/pattern`,
        message: "must be a header value the transport sends as stored",
      });
    }
  }
  if (Object.keys(data).some((key) => !fields.includes(key))) {
    errors.push({
      instancePath: "",
      schemaPath: "#/additionalProperties",
      message: "must NOT have additional properties",
    });
  }
  return errors;
}

export type EmptySecret = Readonly<Record<never, never>>;
export type BearerTokenSecret = { readonly token: string };
export type ApiKeySecret = { readonly apiKey: string };

// For an upstream that needs no credential. The deployment still names a secret, which must be
// the empty object, so an unused token cannot sit in one unnoticed.
export function noAuth(): OpenApiRestAuth<EmptySecret> {
  return {
    validateSecret: validator<EmptySecret>((data) =>
      objectWithFields(data, []),
    ),
    headers: [],
    create: () => ({ headers: () => Promise.resolve({}) }),
  };
}

// Sends `Authorization: Bearer <token>` from a secret of the form { "token": "..." }.
export function bearerToken(): OpenApiRestAuth<BearerTokenSecret> {
  return {
    validateSecret: validator<BearerTokenSecret>((data) =>
      objectWithFields(data, ["token"]),
    ),
    headers: ["authorization"],
    create: ({ secret }) => ({
      async headers() {
        const { token } = await secret.get();
        return { authorization: `Bearer ${token}` };
      },
    }),
  };
}

// Sends the key from a secret of the form { "apiKey": "..." } in the named header.
export function apiKey(options: {
  readonly header: string;
}): OpenApiRestAuth<ApiKeySecret> {
  const header = normaliseHeaderName(options.header, "apiKey auth");
  return {
    validateSecret: validator<ApiKeySecret>((data) =>
      objectWithFields(data, ["apiKey"]),
    ),
    headers: [header],
    create: ({ secret }) => ({
      async headers() {
        const { apiKey } = await secret.get();
        return { [header]: apiKey };
      },
    }),
  };
}
