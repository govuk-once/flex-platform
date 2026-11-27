---
title: Glossary
description: The terms these docs use, and what each means on the platform.
---

## API Gateway

Amazon API Gateway. These docs always name it in full, to keep it separate from a _gateway_.
Each domain is an API Gateway, and many upstreams run on it too.

## Bundle

A domain's code, as one zip, uploaded under a version through the pipeline API. A version names
one bundle for good. See [Uploading a bundle](/flex-platform/domains/hosting/#uploading-a-bundle).

## Call contract

The TypeScript types that codegen writes to `.gen/client/rpc.ts`. They give each operation's
input and the union of its outcomes. A caller compiles against the call contract, and it types
the gateway client. See
[The call contract](/flex-platform/codegen/call-contract/).

## Caller token

The token Lambda@Edge signs to say who a request is for, sent to a domain as `x-flex-secure`. A
domain passes it on to the gateways it calls, and each gateway verifies it before it acts. See
[The caller token](/flex-platform/frontdoor/caller-token/).

## CloudFront Function

The Frontdoor's first check on a request. It checks the request's structure before anything else
acts on it. See [CloudFront Function](/flex-platform/frontdoor/cloudfront-function/).

## Domain

The logic behind a personalised feature of the GOV.UK app. Developers outside the platform team
write domains, and the Frontdoor routes requests to them. Each domain is an API Gateway with a
Lambda proxy integration, in isolated subnets. See [Domains](/flex-platform/domains/overview/).

## Domain account

An AWS account that holds an environment's domains, the gateways they call, and the network both
run in. See [Stages and environments](/flex-platform/infrastructure/overview/#stages-and-environments).

## Domain SDK

`@govuk-once/flex-domain-sdk`. A domain's code uses this package to declare its configuration,
type its handlers and answer its requests. See [Domain SDK](/flex-platform/domains/overview/#domain-sdk).

## Driver

The package that owns a gateway's transport, such as HTTP. It is the only code that names methods,
paths, status codes or headers. See [The driver contract](/flex-platform/drivers/contract/).

## Egress

The section of the platform that domains use to reach upstreams. It is made up of the gateways
and the network around them.

## Envelope

What a gateway's handler receives and returns. It receives `{ operation, input, secure }`. It
returns `{ ok, outcome, data }` or `{ ok, error: { code } }`. Either may carry an optional `meta`. See
[Responses and errors](/flex-platform/gateways/responses/).

## Environment

One Frontdoor and its domain accounts, as the app uses them. Domain teams use the development,
staging and production environments. All three are in the platform-prod stage. See
[Infrastructure](/flex-platform/infrastructure/overview/#stages-and-environments).

## Frontdoor

The single CloudFront distribution that every request to the platform enters through. See
[Frontdoor](/flex-platform/frontdoor/overview/).

## Frontdoor account

The AWS account that holds an environment's Frontdoor, and the caller token's keys. See
[Stages and environments](/flex-platform/infrastructure/overview/#stages-and-environments).

## Gateway

A Lambda function, generated from this repository, that sits in front of one upstream and exposes
its operations to domains. Never Amazon API Gateway, which these docs name in full. See
[How a gateway works](/flex-platform/gateways/overview/).

## Gateway client

`@govuk-once/flex-gateway-client`. A domain calls a gateway through it. The client invokes the
gateway's Lambda function directly, by a name derived from the gateway's id. Each gateway's client
package creates a client typed by the gateway's call contract. See
[Calling gateways](/flex-platform/domains/overview/#calling-gateways).

## Lambda@Edge

The Frontdoor's function that authenticates a request with Amazon Cognito, routes it to a domain
and signs it with SigV4. See [Lambda@Edge](/flex-platform/frontdoor/lambda-edge/).

## Operation

One thing a gateway can do with its upstream, such as `createUser`. The gateway's configuration
names each operation.

## Outcome

The name of a successful result, such as `ok` or `created`. A caller sees an outcome, never a
status code.

## Pairwise ID

The ID One Login gives a user at one service. The caller token's `pairwiseId` is the verified
access token's `username`, and `service` names the service whose ID it is.

## Pipeline API

The API under `/ci` in a stage's shared account. A domain's pipeline uploads and releases its code
through it, with the token GitHub issues the job, so the pipeline holds no AWS credentials. See
[The pipeline API](/flex-platform/domains/hosting/#the-pipeline-api).

## Placement

Where a workload's Lambda runs. There are two placements:

- `isolated`: no route to the internet. A domain's function always runs here, and so does a
  gateway whose upstream it reaches through a VPC endpoint.
- `private`: the gateway reaches the internet through a NAT gateway. Egress filtering between the
  two is planned.

Each is a tier of subnets in the domain account's
[network](/flex-platform/infrastructure/network/#tiers).

## Push ID

The ID a caller's notifications are pushed to. Lambda@Edge derives it from the pairwise ID with a
secret only the edge reads, and signs it into the caller token. See
[The push ID](/flex-platform/frontdoor/caller-token/#the-push-id).

## Release

Two things in these docs:

- **Releasing a domain** puts a bundle a domain uploaded on its function's `live` alias. See
  [Releasing a domain's function](/flex-platform/domains/hosting/#releasing-a-domains-function).
- **Releasing packages** publishes the packages domains install, such as the gateway client. See
  [Releasing packages](/flex-platform/start/releasing/).

## Schema version

One numbered JSON file in a gateway's `schemas/` directory. A merged version never changes. Each
version must be [compatible](/flex-platform/gateways/compatibility/) with every version before it.

## Shared account

The AWS account each stage has for what spans its environments: the test user pool, and the
pipeline API, with the bucket and tables domain releases use. See
[Stages and environments](/flex-platform/infrastructure/overview/#stages-and-environments).

## Stage

One of the three copies of the platform that the platform team deploys through: platform-dev,
platform-staging and platform-prod. Each stage has its own accounts, and one or more environments. See
[Infrastructure](/flex-platform/infrastructure/overview/#stages-and-environments).

## Test user

A user in a stage's test user pool. Software signs in as this user with a generated password, to
test an environment from outside the platform. See
[Test users](/flex-platform/infrastructure/overview/#test-users).

## Upstream

The system a gateway calls. It holds data a domain needs. It can be another team's API, an
AWS-hosted service or a third party.

## User Data Platform

The upstream that holds what GOV.UK keeps for a user of the app, such as their linked accounts and
notification preferences. It is also called UDP. Its gateway is the implemented example in this
repository.
