---
title: Authentication
description: "How openapi-rest authenticates to an upstream: secret fields, apiKey, sigV4 and custom parts."
---

The `auth` field of `openapiRest` lists, in order, the parts that authenticate a request. Use `[]`
for an upstream that takes no credential. Each part names the headers it sets and the fields of
the gateway's secret it reads. Each part also sees the headers that the parts before it set, so a
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

There are no defaults, because a secret may be the gateway's own, or one the upstream provides in
its own shape. Only the configuration says which field means what. A credential can only be given
with `fromSecret`, so no credential can be written into a configuration.

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
is logged by name as the gateway starts. Anything that reads it does without it. For example, a
header is left out, or `FLEX_UPSTREAM_TARGET` is used instead. Only mark a field optional if the
deployment is valid without it. If the upstream still expects the header, it will refuse every
request.

The driver checks the secret against the fields the configuration names, and nothing else:

- Each named field must be present, unless it is optional.
- Each must be a non-empty string that can be sent exactly as stored. It may not contain a
  control character other than tab. It may not start or end with a space or tab, because the
  `Headers` class would strip them.

A field that no part names is never read, so an upstream's secret may hold anything else.
Diagnostics name the field and the rule, never a value.

### Reading and rotation

The runtime caches the secret for five minutes. See
[The secret](/flex-platform/reference/environment/#the-secret).

The driver checks every named field on every read. A secret that fails the checks is never
returned. Instead the operation fails as `INTERNAL`, the same as when a read fails.

Rotating credentials in the secret needs no restart. Authentication parts receive the newly
validated fields after the cache expires. A part that exchanges them for a token or session also
manages that token or session's lifetime. The driver reads the upstream target only when the
executor is created, so changing a target stored in the secret requires a new executor.

## sigV4

`sigV4` is for an upstream behind IAM authorisation, such as an Amazon API Gateway stage. Its
`service` must be `"execute-api"`.

Signing is not one algorithm with a service name plugged in. For example, S3 wants the hash of the
body in a header and its path left unnormalised, and this signer does neither. Support for another
service is added by implementing what that service needs, so the signer refuses a service that is
only named.

`region` is the upstream's region, and it is part of what is signed. Write it in the
configuration, or read it from the secret if the upstream keeps it there.

`sigV4` signs as a role that the upstream's owner grants to the gateway's account. The gateway
assumes the role through STS with its own credentials, so its execution role needs permission to
assume the role the secret names. When it assumes the role, it passes:

- the external ID, if the role's trust policy asks for one;
- a session name, which appears in the upstream's audit trail.

The gateway keeps the credentials STS returns until five minutes before they expire, then assumes
the role again. If the secret is rotated to another role, the gateway assumes that role on the
next request.

Role assumption goes to STS through the AWS SDK. This is the one exception to using the driver's
transport. Each call to STS has these limits:

| Limit | Value |
|---|---|
| Connect | 2 s |
| Request | 5 s |
| Retries | The SDK's own, left on |

The SDK's retries stay on because assuming a role sends nothing to the upstream.

The gateway calls STS in its own region, whatever region the upstream signs in. Credentials from a
regional STS endpoint are valid in every region, and the gateway's
[network](/flex-platform/infrastructure/network/#endpoints) reaches STS in its own region only.

The signature covers the method, the address, the headers set before it and a hash of the body.
The signer leaves out `authorization`, which carries the signature. It also leaves out the headers
a transport or a proxy may add or change: `cache-control`, `connection`, `expect`, `from`,
`keep-alive`, `max-forwards`, `pragma`, `referer`, `te`, `trailer`, `transfer-encoding`,
`upgrade`, `user-agent`, `x-amzn-trace-id`, and any `proxy-` or `sec-` header. These are sent
unsigned. So if a mapping sets one, the upstream cannot tell whether its value was changed on the
way.

The hash of the body is part of the signature and is not sent as a header. If a request already
carries a hash, the signer uses it instead of hashing the body. So a mapping that sent
`UNSIGNED-PAYLOAD` would make the signature the same for every body. That is why `sigV4` owns
`X-Amz-Content-Sha256`: nothing else can supply one. If one reaches the signer anyway, it is
removed first.

The driver refuses a query parameter named `__proto__`, and does not sign it. The signer reads a
query through an ordinary object, where `__proto__` is the object's prototype and not a key. The
request would then carry a parameter the signature did not cover.

## Custom parts

A custom flow is one more part, written with `defineAuth`. A part is data. It declares:

- the headers it owns;
- the fields it reads;
- a `create` function that builds its state for each executor.

Nothing in a part reads a secret or exchanges a token when the configuration is imported. This lets
codegen load a configuration without an environment or AWS access. No two parts may own the same
header.

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
the operation's timeout. The driver reports a part's own `GatewayError` unchanged. It replaces any
other error the part raises with an `INTERNAL` diagnostic that names only the operation. The part
is responsible for token and session expiry.

## When the upstream refuses a credential

If the upstream answers with a 401 or a 403, the secret may have been rotated since it was
cached. The driver handles this in two steps:

1. It calls each part's `refused()`, so the next request authenticates from scratch.
2. It reads the secret again from the store, bypassing and refreshing the cache.

The read happens inside the attempt, so the policy timeout covers it too. What happens next depends
on the method.

- **A GET is sent once more**, inside the same attempt, so the policy timeout covers both
  requests. Only the second answer is mapped and counted towards upstream health. If the second
  request is also refused, the result is `UPSTREAM_REJECTED`. If the secret cannot be read again,
  the GET is not sent and the result is `INTERNAL`.
- **Any other method is not sent again.** Its refusal is the result, even if the secret cannot be
  read again. The driver logs a failed read, and the next request meets it. If the read outlasts
  the timeout, the result is still `UPSTREAM_TIMEOUT`. A 401 or a 403 does not show that the
  upstream refused before it acted. Amazon API Gateway passes on whatever status the service
  behind it chose, and that service may have done the work first.

A gateway whose `auth` is `[]` does none of this, because a refusal there is not about a
credential. The driver logs each refusal, with its status and whether the request was sent again.
