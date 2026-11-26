// Shorthand for a failure a handler answers with: `return notFound()` is `return { status: 404 }`.
// Each returns a plain response, so the handler's type holds it to what its route declares, as it
// holds one written out.

export interface ClientError<Status extends number> {
  (): { readonly status: Status };
  <Body>(body: Body): { readonly status: Status; readonly body: Body };
}

function clientError<Status extends number>(
  status: Status,
): ClientError<Status> {
  function respond(): { readonly status: Status };
  function respond<Body>(body: Body): {
    readonly status: Status;
    readonly body: Body;
  };
  function respond(...body: readonly unknown[]) {
    return body.length === 0 ? { status } : { status, body: body[0] };
  }

  return respond;
}

export type ServerError<Status extends number> = () => {
  readonly status: Status;
};

function serverError<Status extends number>(
  status: Status,
): ServerError<Status> {
  return (): { readonly status: Status } => ({ status });
}

// A failure of the route's own, which its `responses` declares, with the body its schema takes.

/** A 400: the request is not one the route can act on. */
export const badRequest: ClientError<400> = clientError(400);

/** A 404: what the request names does not exist. */
export const notFound: ClientError<404> = clientError(404);

/** A 409: the request conflicts with what is already there. */
export const conflict: ClientError<409> = clientError(409);

/** A 422: the request is well formed, and what it asks for is not allowed. */
export const unprocessable: ClientError<422> = clientError(422);

/** A 429: the caller has made too many requests. */
export const tooManyRequests: ClientError<429> = clientError(429);

// A failure that is not the route's own, which any handler may answer with.

/** A 500: the handler itself failed. */
export const internalError: ServerError<500> = serverError(500);

/** A 502: a gateway or its upstream answered with a failure. */
export const badGateway: ServerError<502> = serverError(502);

/** A 503: a gateway or its upstream cannot take the call now. */
export const unavailable: ServerError<503> = serverError(503);

/** A 504: a gateway or its upstream did not answer in time. */
export const gatewayTimeout: ServerError<504> = serverError(504);
