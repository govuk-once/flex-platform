---
title: Glossary
description: The terms these docs use, and what each means on the platform.
---

## API Gateway

Amazon API Gateway. These docs always name it in full to keep it separate from a _gateway_. Each
domain is an API Gateway, and many upstreams run on it too.

## Call contract

The TypeScript types that codegen writes to `.gen/client/rpc.ts`: each operation's input and the
union of its outcomes. A caller compiles against it, and the client libraries will be built from
it. See [The call contract](/flex-platform/codegen/call-contract/).

## CloudFront Function

The Frontdoor's first check on a request. It checks the request's structure before anything else
acts on it. Planned.

## Domain

The logic behind a personalised feature of the GOV.UK app. Developers outside the platform team
write domains, and the Frontdoor routes requests to them. Each domain is an API Gateway with a
Lambda proxy integration, in isolated subnets. Planned. See [Domains](/flex-platform/domains/overview/).

## Domain library

A library, with examples, that domain developers install to build a domain. Planned.

## Driver

The package that owns a gateway's transport, such as HTTP. It is the only code that names methods,
paths, status codes or headers. See [The driver contract](/flex-platform/drivers/contract/).

## Egress

The section of the platform that domains use to reach upstreams: the gateways and the network
around them.

## Envelope

What a gateway's handler receives and returns. It receives `{ operation, input, secure }`. It
returns `{ ok, outcome, data }` or `{ ok, error: { code } }`. See
[Responses and errors](/flex-platform/gateways/responses/).

## Frontdoor

The single CloudFront distribution that every request to the platform enters through. Planned. See
[Frontdoor](/flex-platform/frontdoor/overview/).

## Gateway

A Lambda function, generated from this repository, that sits in front of one upstream and exposes
its operations to domains. See [How a gateway works](/flex-platform/gateways/overview/).

## Gateway client library

A typed library, generated from a gateway's call contract, that a domain installs to invoke the
gateway's Lambda function directly. Planned.

## Lambda@Edge

The Frontdoor's function that authenticates a request with Amazon Cognito, routes it to a domain
and signs it with SigV4. Planned.

## Operation

One thing a gateway can do with its upstream, such as `createUser`. The gateway's configuration
names each operation.

## Outcome

The name of a successful result, such as `ok` or `created`. A caller sees an outcome, never a
status code.

## Placement

Where a gateway's Lambda runs. There are two placements:

- `isolated`: no route to the internet. The gateway reaches its upstream through a VPC endpoint.
- `private`: the gateway reaches the internet through a NAT gateway and AWS Network Firewall.

## Schema version

One numbered JSON file in a gateway's `schemas/` directory. A merged version never changes. Each
version must be [compatible](/flex-platform/gateways/compatibility/) with every version before it.

## Upstream

The system a gateway calls, which holds data a domain needs. It can be another team's API, an
AWS-hosted service or a third party.

## User Data Platform

The upstream that holds what GOV.UK keeps for a user of the app, such as their linked accounts and
notification preferences. Also called UDP. Its gateway is the implemented example in this
repository.
