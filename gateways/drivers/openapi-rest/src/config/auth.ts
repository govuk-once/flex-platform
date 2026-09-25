import { normaliseHeaderName } from "../headers.ts";
import type { HttpMethod, OpenApiRestResponse } from "../types.ts";
import {
  isSecretField,
  type SecretField,
  type SecretValues,
} from "./secret-field.ts";

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
  // The request as it is about to be sent, for a scheme that signs what it authenticates rather
  // than attaching a credential to it. Everything is a copy: what a flow does to it changes
  // nothing that is sent, and the only way it adds to the request is the headers it returns.
  readonly method: HttpMethod;
  // Where it is going, query included, as resolved against the upstream target.
  readonly url: URL;
  // The headers set so far: the driver's, the gateway's static ones, the call's and, where
  // there is a body, its content type. Never the ones this flow owns.
  readonly headers: Headers;
  // The body as it will be sent, already serialised, or undefined where there is none.
  readonly body: string | undefined;
}

// Per-executor authentication state. `headers` runs inside every request's attempt and returns
// the headers to apply, whose names must be among those the definition declares.
export interface OpenApiRestAuthInstance {
  headers(
    request: OpenApiRestAuthRequest,
  ): Promise<Readonly<Record<string, string>>>;
  // The upstream refused a request this part helped authenticate. Called after the secret has
  // been read again from the store, and before a GET is sent once more: drop what is held, a
  // token or an assumed role's credentials, so the next request authenticates afresh. Optional:
  // a part that holds nothing has nothing to drop.
  refused?(): void;
}

export interface OpenApiRestAuthDeps {
  // The secret fields the gateway's configuration names, read afresh: every value has passed the
  // checks a field is held to on that read. Reads are cheap, since the runtime caches the secret
  // for a bounded age, and a read after the age sees a rotated value.
  readonly secret: { get(): Promise<SecretValues> };
  readonly transport: OpenApiRestAuthTransport;
}

// One part of how a gateway's requests are authenticated: an API key, a signature, a token. A
// gateway lists its parts in order, and each is shown the headers the ones before it set, so a
// signature covers a key. A part is data: it declares which headers it sets and which fields of
// the secret it reads, and builds its state only when the executor is created, so a
// configuration that names one can be imported without a secret or a network. Additional schemes
// are further parts, not cases in the driver.
export interface OpenApiRestAuth {
  // Header names this part sets. Reserved before operations compile: no static header,
  // parameter mapping or handler call may set them, no other part may own them, and the
  // instance may set no other.
  readonly headers: readonly string[];
  // The fields of the secret it reads, each named by the configuration. The secret must hold
  // every one not marked optional, as a non-empty string a header can carry as written.
  readonly fields: readonly SecretField[];
  // Builds the mutable state for one executor. Never performs a retrieval or an exchange
  // itself; those happen when a request's `headers` runs, inside its attempt.
  create(deps: OpenApiRestAuthDeps): OpenApiRestAuthInstance;
}

// Types a part written for one gateway.
export function defineAuth(auth: OpenApiRestAuth): OpenApiRestAuth {
  return auth;
}

// Sends a key from the secret in the named header.
export function apiKey(options: {
  readonly header: string;
  readonly key: SecretField;
}): OpenApiRestAuth {
  const header = normaliseHeaderName(options.header, "apiKey auth");
  if (!isSecretField(options.key)) {
    throw new TypeError(
      "apiKey auth: key must name the secret field that holds it, with fromSecret",
    );
  }
  const { key } = options;
  return {
    headers: [header],
    fields: [key],
    create: ({ secret }) => ({
      async headers() {
        const value = (await secret.get()).get(key);
        return value === undefined ? {} : { [header]: value };
      },
    }),
  };
}
