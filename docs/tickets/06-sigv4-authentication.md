# Sign upstream requests with AWS Signature Version 4, as the gateway's own role

**Placeholder:** FLEX-111
**Branch:** `feat/openapi-rest-sigv4-auth` (4 commits)
**Depends on:** the response metadata ticket

## Why

The upstreams a Flex gateway calls sit behind IAM authorisation — an API Gateway stage, typically.
The driver's three authentication definitions all attach a credential to a request from a stored
secret, and none of them can do this: SigV4 is not a credential attached to a request but a
**signature over** one, and its credentials are the gateway's role's, not a secret's.

## Scope

- Widen what an authentication definition is shown: `headers` is given a copy of the request it is
  authenticating — the `method`, the `url` it is going to with its query, the `headers` set so far
  including the body's content type, and the `body` as it will be sent — as well as the operation's
  name and the attempt's signal. Each is a copy: nothing a flow does to one changes what is sent,
  and the headers it returns are still the only thing it adds, still only those its definition
  declares. A scheme that signs a request needs all of it; one that attaches a token needs none.
- Add `sigV4({ service, region })`. Its secret is `{}`. It sends `Authorization`, `X-Amz-Date` and,
  for a role, `X-Amz-Security-Token`.
- **Credentials come from the gateway's own role through the platform's credential chain, never
  from a secret**: a role's are short-lived and renewed by the platform, and what may call the
  upstream is granted where the role is defined.
- `service` and `region` are the upstream's and part of what is signed. They are the same wherever
  the gateway is deployed, so they are configuration and not environment — design constraint 11
  still holds.
- The signer is loaded on the first request and bundled only into a gateway that uses `sigV4`. The
  credential chain is part of the AWS SDK, which the bundle leaves for the Lambda runtime to supply.
- Design constraint 12 records both: what an authentication is shown, and where `sigV4` takes its
  credentials from.

## Acceptance criteria

- [ ] An `openapi-rest` gateway configured with `sigV4` reaches an IAM-authorised upstream; the
      signature covers the method, the address, the headers set so far and a hash of the body.
- [ ] What an authentication does to the request copy it is shown changes nothing that is sent.
- [ ] The signer appears in the bundle of a gateway that uses `sigV4` and in no other; the AWS SDK
      stays external.
- [ ] `sigV4` reads no secret; a deployment still names one and it must be the empty object.
- [ ] The existing definitions (`noAuth`, `bearerToken`, `apiKey`) are unchanged in behaviour.

## Notes

Nothing replays an upstream operation after an authentication failure, here as everywhere.
