---
title: Authentication
description: "How openapi-rest authenticates to an upstream: secret fields, apiKey, sigV4 and custom parts."
---

The `auth` field of `openapiRest` lists, in order, the parts that authenticate a request. Use `[]`
for an upstream that takes no credential. Each part names the headers it sets and the fields of
the gateway's secret it reads. Each part also sees the headers set by the parts before it, so a
signature can cover a key. The driver comes with two parts:

| Part | Reads | Sends |
|---|---|---|
| `apiKey({ header, key })` | `key` | The key in the named header. |
| `sigV4({ service, region, role })` | `role.arn`, `role.externalId`, and `region` where it names a field | An AWS Signature Version 4 over the request, in `Authorization`, `X-Amz-Date` and `X-Amz-Security-Token`. It also owns `X-Amz-Content-Sha256`, but does not set it. |

This authenticates the gateway _to its upstream_. Authentication of the gateway's own callers is
not implemented.

## Secret fields

A part names each value it reads from the secret by its field, with `fromSecret("field")`. Use
`fromSecret("field", { optional: true })` for a field the secret's owner does not always provide.

There are no defaults. A secret may be the gateway's own, or one the upstream provides in its own
shape. Only the configuration says which field means what. A credential can only be given with
`fromSecret`, so no credential can be written into a configuration.

This is UDP's configuration. The secret belongs to UDP:

```ts
openapiRest({
  spec: "…",
  target: fromSecret("apiUrl"),
  auth: [
    apiKey({ header: "x-api-key", key: fromSecret("apiKey") }),
    sigV4({
      service: "execute-api",
      region: fromSecret("region"),
      role: {
        arn: fromSecret("consumerRoleArn"),
        externalId: fromSecret("externalId", { optional: true }),
        sessionName: "consumer-session",
      },
    }),
  ],
});
```

If a required field is missing, the gateway does not start. If an optional field is missing, it
is logged by name as the gateway starts. Anything that reads it does without it: a header is
left out, or `UPSTREAM_TARGET` is used instead. Only mark a field optional if the deployment is
valid without it. If the upstream still expects the header, it will refuse every request.

The secret is checked against the fields the configuration names, and nothing else:

- each named field must be present, unless it is optional;
- each must be a non-empty string that can be sent exactly as stored. It may not contain a
  control character other than tab. It may not start or end with a space or tab, because the
  `Headers` class would strip them.

A field that no part names is never read, so an upstream's secret may hold anything else.
Diagnostics name the field and the rule, never a value.

### Reading and rotation

The runtime reads the secret through Powertools Parameters. Powertools serves a retrieved copy
for five minutes, then reads again on the first call after that. Concurrent calls on a cold or
expired cache may each read the secret. Nothing coordinates them.

Every named field is checked on every read. A secret that fails the checks is never returned.
The operation fails as `INTERNAL` instead, the same as when a read fails. Rotating the secret
needs no restart for credential changes. Authentication parts receive the newly validated fields
after the cache expires; a part that exchanges them for a token or session also manages that
token or session's lifetime. The upstream target is read when the executor is created, so changing
a target stored in the secret requires a new executor.

## sigV4

`sigV4` is for an upstream behind IAM authorisation, such as an Amazon API Gateway stage. Its
`service` must be `"execute-api"`. Signing is not one algorithm with a service name plugged in.
For example, S3 wants the hash of the body in a header and its path left unnormalised, and this
signer does neither. Support for another service is added by implementing what that service
needs, so a service that is only named is refused.

`region` is the upstream's region, and it is part of what is signed. Write it in the
configuration, or read it from the secret if the upstream keeps it there.

`sigV4` signs as a role that the upstream's owner grants to the gateway's account. The gateway
assumes the role through STS with its own credentials, so its execution role needs permission to
assume the role the secret names. It passes:

- the external ID, if the role's trust policy asks for one;
- a session name, which appears in the upstream's audit trail.

The credentials STS returns are kept until five minutes before they expire. The role is then
assumed again. If the secret is rotated to another role, that role is assumed on the next
request. Role assumption goes to STS through the AWS SDK. This is the one exception to using the
driver's transport.

The signature covers the method, the address, the headers set before it and a hash of the body.
The signer leaves out the few headers a transport may add or change: `user-agent`, `expect`, and
any `proxy-` or `sec-` header. These are sent unsigned.

The hash of the body is part of the signature and is not sent as a header. `sigV4` owns
`X-Amz-Content-Sha256` so that nothing else can supply one. The signer uses a hash already on a
request instead of hashing the body. So a mapping that sent `UNSIGNED-PAYLOAD` would make the
signature the same for every body. If one reaches the signer anyway, it is removed first.

A query parameter named `__proto__` is refused and not signed. The signer reads a query through
an ordinary object, where `__proto__` is the object's prototype and not a key. The request would
then carry a parameter the signature did not cover.

## Custom parts

A part is data. It declares the headers it owns, the fields it reads, and a `create` function
that builds its state for each executor. Nothing in a part reads a secret or exchanges a token
when the configuration is imported. This lets codegen load a configuration without an
environment or AWS access. No two parts may own the same header. A custom flow is one more part,
written with `defineAuth`:

```ts
import { defineAuth, fromSecret } from "@repo/gateway-driver-openapi-rest";
import { GatewayError } from "@repo/gateway-runtime";

const CLIENT_ID = fromSecret("clientId");
const CLIENT_SECRET = fromSecret("clientSecret");
const TOKEN_URL = fromSecret("tokenUrl");

export const clientCredentials = defineAuth({
  headers: ["authorization"],
  fields: [CLIENT_ID, CLIENT_SECRET, TOKEN_URL],
  create: ({ secret, transport }) => {
    let token: { value: string; expiresAt: number } | undefined;
    return {
      async headers({ signal }) {
        if (token === undefined || token.expiresAt <= Date.now()) {
          const values = await secret.get();
          const response = await transport.request(
            {
              method: "POST",
              url: values.get(TOKEN_URL) ?? "",
              form: {
                grant_type: "client_credentials",
                client_id: values.get(CLIENT_ID) ?? "",
                client_secret: values.get(CLIENT_SECRET) ?? "",
              },
            },
            signal,
          );
          if (response.status !== 200) {
            throw new GatewayError("UPSTREAM_REJECTED", `Token endpoint returned ${response.status}`);
          }
          const body = response.json() as { access_token: string; expires_in: number };
          token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
        }
        return { authorization: `Bearer ${token.value}` };
      },
      refused() {
        token = undefined;
      },
    };
  },
});
```

In this example, concurrent requests on an expired token each make their own exchange. If the
token endpoint should see only one exchange, keep one pending promise for it.

| `create` receives | |
|---|---|
| `secret` | `get()` returns the named fields of the current secret, already checked, as a map keyed by `fromSecret` field. |
| `transport` | `request(call, signal)` sends one request to an absolute URL or a path on the target, with a JSON or form body. It applies the response limit and returns the raw status, headers and body. Statuses are not mapped. The same https-only rule as the target applies. This is the only way a part reaches the network. |

| The instance returns | |
|---|---|
| `headers(call)` | The headers to add. Only headers the part declared are allowed. It is given the operation's name, the attempt's signal, and a copy of the request: `method`, `url` with its query, the `headers` set so far, and `body` as it will be sent. A scheme that signs needs all of this. One that attaches a token needs none of it. Nothing it changes on the copy is sent. |
| `refused()` | Optional. Called when the upstream refuses the gateway's credentials. It should drop anything it holds, such as a token or an assumed role's credentials. |

`headers` runs inside each request's attempt, so a secret read or a token exchange counts against
the operation's timeout. A part's own `GatewayError` is reported unchanged. Any other error it
raises is replaced with an `INTERNAL` diagnostic that names only the operation. The part is
responsible for token and session expiry.

## When the upstream refuses a credential

If the upstream answers with a 401 or a 403, the secret may have been rotated since it was
cached. The driver then reads the secret again from the store, bypassing and refreshing the
cache. Before that, it calls each part's `refused()`, so the next request authenticates from
scratch. The read happens inside the attempt, so the policy timeout covers it too.

- **A GET is sent once more**, inside the same attempt, so the policy timeout covers both
  requests. Only the second answer is mapped and counted towards upstream health. If the second
  request is also refused, the result is `UPSTREAM_REJECTED`. If the secret cannot be read again,
  the GET is not sent and the result is `INTERNAL`.
- **Any other method is not sent again.** Its refusal is the result, even if the secret cannot be
  read again; a failed read is logged, and the next request meets it. A read that outlasts the
  timeout still makes the result `UPSTREAM_TIMEOUT`. A 401 or a 403 does not show that the
  upstream refused before it acted. Amazon API Gateway passes on whatever status the service
  behind it chose, and that service may have done the work first.

A gateway whose `auth` is `[]` does none of this, because a refusal there is not about a
credential. The driver logs each refusal, with its status and whether the request was sent again.
