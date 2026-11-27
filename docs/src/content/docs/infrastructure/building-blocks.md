---
title: Building blocks
description: "Patterns more than one section's stacks use: values that cross regions, a function only CloudFront may call, and a DynamoDB table's policy."
---

These are in `infra/constructs`, for any section's stacks to use.

## Values that cross regions

A name derived from config can't stand in for a value AWS generates, such as a function URL's
host.

- Within a region, the stack that has the value writes it to SSM, and its reader resolves it at
  deploy. A domain's stack reads its account's
  [certificate ARN](/flex-platform/domains/hosting/#what-a-domain-account-provides) this way.
- CloudFormation writes a parameter only in a stack's own region. So for a reader in another
  region, the stack that has the value uses `CrossRegionParameters`, from `infra/constructs`. A
  custom resource writes each value to a parameter in the reader's region when the stack
  deploys, so synth stays offline.
- The value is the custom resource's own property. So it is written again when it changes, and
  never otherwise, and a template is the same from one synth to the next.
- The reader uses `valueForStringParameter` and declares the dependency. It deploys with
  `--force` after the value changes.

`shared-management` reads the host of the pipeline API's function URL this way.

CloudFormation holds the custom resource, not the parameter. So these parameters are the one
thing the stacks create that the [inventory](/flex-platform/infrastructure/checks-and-tests/#tests) doesn't list. Each is under
`/flex/cross-region/`, named by `crossRegionParameterName`, which is how to tell one from a
parameter nothing accounts for.

A stack has one `CrossRegionParameters`, which takes its values by region. CDK runs every such
custom resource in a stack in one function. Here that function runs as a role that may write only
those parameters, and logs to a log group the stack names.

## A function behind CloudFront

A Lambda function that only CloudFront may call is reached at its function URL. Two functions in
`infra/constructs` set this up, one on each side:

- `cloudFrontFunctionUrl`, in the function's stack, gives the function a URL with IAM
  authorisation. Lambda then takes only requests signed with SigV4 by a caller IAM allows. It
  returns the URL's host.
  - The function's policy admits CloudFront alone, for any distribution in the function's account.
  - Lambda checks two actions for a call through a URL, `lambda:InvokeFunctionUrl` and
    `lambda:InvokeFunction`. So the policy allows both, and limits the second to calls through the
    URL, so CloudFront can't invoke the function any other way.
  - The policy names no one distribution. AWS chooses a distribution's ID, and the distribution
    needs the URL's host first, so naming it would make each wait for the other.
- `functionUrlOrigin`, in the distribution's stack, gives the origin for that host, reached over
  HTTPS and TLS 1.2. Its origin access control signs every request, and replaces any
  `Authorization` header a caller sent with CloudFront's own.

Lambda refuses a request sent straight to the URL from outside the account before the function
runs. Inside the account, as for any function, a principal whose own policy allows the call can
make it. So the function relies on what it checks itself, never on where a request came from.

The platform builds a distribution in us-east-1. If the function is in another region, its stack
passes the host on through [`CrossRegionParameters`](/flex-platform/infrastructure/overview/#rules-for-stacks-and-constructs).

Each function builds in the scope it is given, not in a construct of its own, because construct
IDs are a contract. The URL is the function's `FunctionUrl`, and a new ID would replace it, with a
new host. A synth [check](/flex-platform/infrastructure/checks-and-tests/#checks) refuses a function URL with any other authorisation.

## A table's policy

Every DynamoDB table the platform holds gets its policy from `tablePolicy`, in `infra/constructs`.
The table's construct passes it each set of roles that uses the table, and what each set does to
the table's items. The policy then denies:

- to anyone outside those roles, everything but managing the table;
- to each set, everything but its own work.

Each deny names what it allows rather than what it refuses. So it also covers every other way to
reach an item: PartiQL statements, batch writes, exports, backups and restores, and any action
DynamoDB adds later. A deny in a resource's policy holds whatever a principal's own policy allows.
A table may add statements of its own, such as an allow for another account's roles, or a deny on
changing certain attributes.

Each deny names the table and every index of it, `table/<name>/index/*`. An index is a resource of
its own, which a statement naming only the table doesn't reach. So adding an index to a table
gives no way around its policy.

Managing the table means seeing its settings and policy, and doing what CloudFormation's
`AWS::DynamoDB::Table` handler does on an update: changing the table, its policy, its tags, its
point-in-time recovery and its contributor insights. The policy leaves out these handler actions:

- those that reach an item;
- those that copy items to a Kinesis stream or a replica;
- setting a time to live, `dynamodb:UpdateTimeToLive`, which no one may do. No table uses one.
  A time to live set on an attribute that holds a time, such as the moment a key starts, would
  have DynamoDB delete every item whose time has passed.

The policy leaves managing the table open to every role outside the sets. So it needn't name any
role a deploy runs as, which the platform doesn't choose, and no deploy is ever locked out of a
table. It also means a principal whose own policy allows `dynamodb:PutResourcePolicy` can rewrite
the table's policy. So who may do that in the account matters as much as the policy.

A role appears in one set only, since each set's deny would refuse the other set's work. A set may
name roles by a pattern, such as every gateway's role.
