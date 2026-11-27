---
title: Network
description: The VPC in each domain account that domains and gateways run in, its tiers, endpoints, DNS filtering and logs, and how other stacks find its IDs.
---

Each domain account has one network in each environment, in its own stack,
`network-<environment>-<account>`, in eu-west-2. Domains and gateways run in it. A domain's stack
holds its function to the network's [placement](/flex-platform/domains/hosting/#network), and a
gateway's stack runs its function in its placement.

The network's constructs are in `infra/constructs/src/network/`, and
`infra/app/src/stacks/network.ts` puts them together.

The network decides where a workload may send traffic. It doesn't create any workload. Each
workload will find the subnets and security group it runs in through
[the IDs the network writes to SSM](#ids-other-stacks-read).

## Tiers

Each availability zone has three subnets, one per tier:

| Tier | For | Route out |
|---|---|---|
| `isolated` | Domains, and gateways whose upstream is reached privately | None. Only the VPC itself, including its [interface endpoints](#endpoints) |
| `private` | Gateways whose upstream is reached over the internet | Its zone's NAT gateway |
| `public` | Only the NAT gateways | The internet gateway |

A workload's tier is its [placement](/flex-platform/reference/glossary/#placement). No subnet gives
anything in it a public IP address. Filtering the private tier's traffic beyond DNS is planned.

### Availability zones

Each domain account lists its availability zones in config, as `network.availabilityZones`.
platform-dev and platform-staging use `eu-west-2a` and `eu-west-2b`. The environments in
platform-prod use all three zones. Each zone listed has its own NAT gateway, which is most of what
a zone costs. Config must list at least two zones, each only once, and only eu-west-2's.

Every subnet's range is fixed by its zone, not by its position in the list:

| Block | Holds |
|---|---|
| `10.0.0.0/18` | `isolated`, a `/20` per zone, one spare |
| `10.0.64.0/18` | `private`, a `/20` per zone, one spare |
| `10.0.128.0/22` | `public`, a `/24` per zone |
| `10.0.132.0/24` | Reserved for egress filtering, a `/28` per zone. Nothing is created in it yet |

So adding or removing a zone never changes another zone's subnets, and the order of zones in
config changes nothing. If a subnet's range changed, the subnet would be replaced, and so would
everything in it. The layout is `ZONE_LAYOUT` in `infra/constructs/src/network/layout.ts`, and a
test checks that no two blocks overlap.

Every account uses `10.0.0.0/16`. Nothing peers with another network, so accounts may overlap.

CDK's `Vpc` checks its zones against its stack's zones. A stack that doesn't name its own zones
looks them up in the account at synth. So the network's stack names its zones by overriding
`availabilityZones`, and `NetworkVpc` refuses a stack that doesn't.

## What a workload may reach

Every workload runs in a security group for its kind. The group lets nothing in, and lets traffic
out only on TCP port 443:

| Workload | Tier | May reach |
|---|---|---|
| `domain` | `isolated` | The `lambda` endpoint |
| `isolated-gateway` | `isolated` | The `secretsmanager`, `sts`, `dynamodb` and `execute-api` endpoints |
| `private-gateway` | `private` | The `secretsmanager`, `sts` and `dynamodb` endpoints, and its zone's NAT gateway |

Each endpoint has a use:

- A domain uses `lambda` to invoke gateways.
- A gateway uses `secretsmanager` to read its secret.
- A gateway uses `sts` to assume an upstream's role for
  [`sigV4`](/flex-platform/drivers/openapi-rest/authentication/).
- A gateway uses `dynamodb` to read the [caller token's keys](#the-caller-tokens-keys).
- An isolated gateway uses `execute-api` to call an upstream's [private API](#private-apis).

Each endpoint's own security group lets in only the workloads that may reach it, and lets nothing
out. A workload's role decides what the workload may call. An endpoint's policy applies to the
requests sent through that endpoint.

`WorkloadSecurityGroup` writes out the rules between a workload's group and an endpoint's group.
It doesn't use CDK's `connections`, for two reasons. `connections` would name each rule after the
other group's construct path, stack name included. It would also drop the rule CDK uses to keep
EC2's default allow-all egress off a group that has no other rule.

### Endpoints

The isolated subnets reach AWS through interface endpoints. Every endpoint but `dynamodb` has
private DNS, so the SDK's usual hostname resolves to the endpoint. DynamoDB's interface endpoint
has no private DNS, so a client calls it at its own name. See
[the caller token's keys](#the-caller-tokens-keys).

Each endpoint's policy refuses any resource it doesn't name, and any action but its own. Every
policy but `execute-api`'s also refuses any principal outside the account. An endpoint with
nothing to name refuses everything, since an endpoint with no policy would allow everything:

| Endpoint | Allows |
|---|---|
| `lambda` | `lambda:InvokeFunction` on `gateway-<environment>-*:live`, a gateway's alias and nothing else of it |
| `secretsmanager` | `secretsmanager:GetSecretValue` on the account's gateways' secrets, by a gateway's role alone |
| `sts` | `sts:AssumeRole` on each role the account's gateways sign as, by a gateway's role alone |
| `dynamodb` | `dynamodb:Scan` on the caller token's public keys table alone, in the frontdoor account, by a gateway's role alone |
| `execute-api` | `execute-api:Invoke` on each private API a gateway names, by a principal of the account of a role a gateway signs as |

An upstream's secret and roles come exactly from each gateway's entry in the
[config](/flex-platform/infrastructure/config/). So if a gateway's upstream holds its
secret or role in its own account, the policy lets the gateway through to that one alone. A call
through an endpoint is logged in the account of the resource it names. So a wider policy would let
a workload signal out to an account someone else controls, through a secret's name or a role's
session name.

Every secret a gateway's stack creates is named by one pattern, `gateway-<environment>-*` in the
domain account, from `gatewaySecretPattern`. The pattern stays one entry however many gateways
have their own secret, which matters because an endpoint's policy is limited to 20,480 characters.
It names only this account, so it reaches no other account's secrets. Only gateways' stacks create
secrets with that prefix.

Only a gateway's role may call the `secretsmanager` and `sts` endpoints. That role is
`gateway-<environment>-*-execution` in the domain account, from `gatewayRolePattern`. So a
domain's role can't read a gateway's secret or assume its upstream's role, even if it were granted
them. Each gateway's own role decides which secret that gateway may read and which role it may
assume. So does the resource policy of a secret the gateway's stack creates. See
[the gateway's function](/flex-platform/reference/environment/#the-lambda-function).

The `lambda` endpoint's pattern comes from `gatewayAliasPattern` in `gateways/infra`. It is built
from `gatewayFunctionPrefix` and the alias's name in `@repo/gateway-core`. These also name each
gateway's function and what its client invokes. Every domain in the environment can invoke any
function in the account that has that prefix and a `live` alias. So the gateways section gives the
prefix to gateways alone. The pattern names the alias, so nothing reaches a gateway without a
qualifier or by a version's number. See
[the Lambda function](/flex-platform/reference/environment/#the-lambda-function).

An endpoint costs the same whether it is used or not, so the network adds one only when something
calls its API. Tracing needs no endpoint, because Lambda's X-Ray daemon sends from outside the
VPC. So neither the X-Ray SDK nor an OpenTelemetry exporter that sends to the daemon over UDP needs
one. An exporter that sends to X-Ray over HTTPS would need an `xray` endpoint.

### Private APIs

An isolated gateway reaches an upstream whose API in API Gateway is private through the
`execute-api` endpoint. The upstream's API has a policy of its own, which names the endpoints it
takes calls from. So give the upstream this network's endpoint ID, with the domain account's ID.
The stack outputs the endpoint ID as `ExecuteApiEndpointId`. Each environment's network has its
own endpoint.

The gateway's entry in [config](/flex-platform/infrastructure/config/) then names the API:

```ts
gateways: [
  {
    id: "udp",
    hostnames: ["a1b2c3d4e5.execute-api.eu-west-2.amazonaws.com"],
    placement: "isolated",
    roleArns: ["arn:aws:iam::111122223333:role/flex-consumer"],
    privateApiArns: ["arn:aws:execute-api:eu-west-2:111122223333:a1b2c3d4e5"],
    // and its secret and target
  },
],
```

The gateway signs a call to a private API as the upstream's own role, in the upstream's account.
It assumes that role for [`sigV4`](/flex-platform/drivers/openapi-rest/authentication/). So this
endpoint's policy can't hold the caller to the domain account, as every other endpoint's policy
does. Instead it lets through a principal of any account that a gateway's `roleArns` names. It
lets that principal call any API that a gateway lists in `privateApiArns`, at any stage, method and
path. A call with no signature has no account, so the endpoint refuses it. The upstream decides
which of those APIs the role may call.

The policy is one statement for every gateway. It grows by each API's ARN and each upstream's
account, since an endpoint's policy can be no longer than 20,480 characters. It doesn't pair each
gateway with its own upstream, because the gateway's role already does that. A gateway signs as an
upstream's role only by assuming it, and its role may assume only the roles it lists in
`roleArns`.

The endpoint's private DNS answers for every name API Gateway gives an API in eu-west-2,
`<api>.execute-api.eu-west-2.amazonaws.com`. It does so whoever owns the API, and whether the API
is private or not. The endpoint reaches only private APIs. So nothing in the network, in either
tier, can call a public API at a name of that form. Call an upstream with a public API at its
custom domain name.

Config is checked when any stage is built. A gateway that lists a private API must:

- be `isolated`;
- list a role;
- list the API's name among its `hostnames`.

Config refuses any other hostname of that form, since the endpoint would answer for it and then
refuse the call.

### NAT addresses

A private gateway's requests leave from its zone's NAT gateway. So an upstream that allowlists
callers allowlists those addresses. Each address is an elastic IP under `NatAddresses`. It is
retained, so it survives the stack. The stack outputs each zone's address, such as
`NatAddresseuwest2a`.

Each NAT gateway has two alarms, set as CloudWatch's recommended alarms for NAT gateways set them:

| Alarm | Goes off when | What it means |
|---|---|---|
| `network-<environment>-nat-<zone>-port-allocation` | The gateway couldn't give a new connection a source port, every minute for 15 minutes | Too many connections are open to one destination |
| `network-<environment>-nat-<zone>-dropped-packets` | The gateway dropped more than 0.01% of its packets, every minute for 5 minutes | Check AWS Health for NAT gateways in the region |

### Network ACLs

Each tier also has a network ACL, beneath the security groups. It holds the tier to its purpose,
whatever a security group allows:

| Rule | Tiers | Direction | Peer | Traffic | Action |
|---|---|---|---|---|---|
| 100 | All | In and out | The VPC | All | Allow |
| 110 | All | In | Anywhere | TCP 0 to 1023 | Deny |
| 111 | All | In | Anywhere | UDP 0 to 1023 | Deny |
| 200 | `private`, `public` | Out | Anywhere | TCP 443 | Allow |
| 200 | `private`, `public` | In | Anywhere | TCP 1024 to 65535 | Allow |

A network ACL applies the lowest-numbered rule that matches, and denies traffic that no rule
matches. It keeps no state, so it lets a reply in by its port alone. A NAT gateway or Lambda may
take any port from 1024 up for a connection. That is why rule 200 lets in every one of those
ports, and why no rule before it refuses one. Rules 110 and 111 only state what the final deny
already does.

## Flow logs

Every flow in the VPC, accepted and rejected, goes to a bucket in the network stack. The logs are
plain text in Hive-style hourly partitions, so Athena can read a window without scanning the rest.
A connection kept open produces one record per direction, on each network interface it crosses,
every ten minutes, which is AWS's default.

The flow logs go to S3 rather than CloudWatch Logs because they are by far the platform's largest
log. S3's delivery costs half as much. The logs also stay out of log forwarding, which would index
every record.

The bucket is a `PlatformBucket`, locked for a year:

| After | What happens to a log |
|---|---|
| 30 days | Moves to S3 Glacier Instant Retrieval |
| A year | Deleted, as long as log groups are kept |

Until then, the bucket keeps every version of a log, however it was overwritten or deleted.

A second flow log sends the rejected flows alone to a `PlatformLogGroup`,
`/flex/network/<environment>/rejected-flows`. A rejection is the security signal in a flow log: it
shows something misconfigured or probing. There should be few. So these are the flows that log
forwarding is to carry to the central logs, without the cost of indexing every flow. Forwarding is
planned.

## DNS filtering

The VPC's Route 53 Resolver filters names with DNS Firewall, which denies by default. A name a
workload asks for resolves only if it is on the VPC's allowlist. The resolver answers any other
name with `NXDOMAIN`. The construct is `DnsFirewall`, in
`infra/constructs/src/network/dns-firewall.ts`.

The allowlist is VPC-wide. Every workload in the network can resolve every name on it, so it
doesn't give one gateway names that another lacks.

### Rules

| Association priority | Rule group | Rule |
|---|---|---|
| 1000 | `network-<environment>-dns-allow` | Allow the names on `network-<environment>-dns-allowed` |
| 9000 | `network-<environment>-dns-block` | Block every name, `*`, for every query type, with `NXDOMAIN` |

DNS Firewall evaluates the lower priority first. The block is a rule group of its own, which no
change to the allowlist touches. The allowlist is a domain list, which the allow group's one rule
names. So adding or removing a name changes that list and nothing else. An update or rollback of
the allowlist never takes the block away, even for a moment.

The allow rule trusts redirection. How an upstream serves its name, such as which CDN it is behind,
is the upstream's to change. So config lists only the names a gateway connects to.

If DNS Firewall can't evaluate a query, the resolver answers `SERVFAIL`, so the VPC fails closed.
That is AWS's default, and nothing in the stack sets it. An `AWS::Route53Resolver::FirewallConfig`
can't set it: CloudFormation refuses one that sets the default, and every other value fails open.
A test checks that the stack has none.

### The allowlist

The allowlist holds the names the SDK calls each [endpoint](#endpoints)'s API at, and the names
every gateway in the domain account declares:

- `lambda.eu-west-2.amazonaws.com`, `secretsmanager.eu-west-2.amazonaws.com` and
  `sts.eu-west-2.amazonaws.com`, which private DNS answers with the endpoints' addresses. Another
  AWS name is added only when a workload is shown to need it. A suffix such as `*.amazonaws.com`
  never is.
- The `dynamodb` endpoint's own regional name exactly, such as
  `vpce-0123456789abcdef0-abcd1234.dynamodb.eu-west-2.vpce.amazonaws.com`. AWS chooses it when the
  endpoint is made, so the stack takes it from the endpoint as it deploys. It is the one name on
  the list that isn't checked as config's names are. `dynamodb.eu-west-2.amazonaws.com` isn't
  listed, since nothing in the VPC may call DynamoDB except through the endpoint.
- Nothing for the `execute-api` endpoint itself. A [private API](#private-apis) is called at its
  own name, which is one of its gateway's names.
- Each gateway's names, from its entry in `gateways` on its domain account in
  [config](/flex-platform/infrastructure/config/). These are the names it connects to:
  its upstream's API and any host it takes a token from.

```ts
gateways: [
  {
    id: "udp",
    hostnames: ["api.udp.example", "auth.udp.example"],
  },
],
```

Config is per environment, so an environment's gateways can use their own names. Every entry is
checked when any stage is built. The allowlist is lowercased, has repeats removed, and is sorted,
so the order of names in config changes nothing. Config refuses an entry that is:

- a URL, or has a path, a query, a user or a port;
- an IP address;
- a wildcard;
- malformed: a label that isn't letters, digits and hyphens, a name of one label, or a name longer
  than 253 characters. Write an internationalised name in its `xn--` form.

Every name is exact. A wildcard can match names its upstream doesn't control, so config admits
none.

A name gets onto the allowlist only through config. Nothing adds a name from a request, a DNS
failure or a secret. If a gateway reads its upstream's address from its secret, that address's
hostname must be in config too, or the gateway can't resolve it.

### Changing the allowlist

- Add a gateway's names in the same change that deploys the gateway, or before. The network stack
  deploys before the stacks that use it.
- Remove a name only once no deployed gateway needs it. Removing a gateway from config removes its
  names, unless another gateway or the platform's baseline still lists them.
- Only the network stack's deployment changes the firewall. No workload's role has any
  `route53resolver` permission, so no workload can change its own allowlist.

### Query logs

Resolver query logging is on for the VPC, to a `PlatformLogGroup`,
`/flex/network/<environment>/dns-queries`. Each record holds:

- the name and its type;
- the answer;
- the address the query came from;
- DNS Firewall's decision, and the rule that made it.

VPC Flow Logs don't see this traffic. A resource policy in the stack lets only this account's log
delivery write to the group.

Resolver doesn't log a query it answers from its cache. So the logs show which names were asked
for, not how often. A name asked for again within its answer's TTL may not appear. A test that
looks for its query in the logs uses a name that no earlier query has asked for.

A query name can carry data that a workload is trying to send out, so these logs are as sensitive
as anything the platform holds. They are encrypted with the stack's log group key, so reading them
takes that key as well as the group. Log forwarding to the central logs is planned.

### Investigating a blocked query

The alarm `network-<environment>-dns-blocked-queries` goes off when DNS Firewall blocks any query in
a five-minute period. Every legitimate name a workload uses is on the allowlist, so any block is
unexpected.

DNS Firewall's metrics arrive several minutes late, so the alarm can go off up to about ten minutes
after the query. Resolver may answer a repeated blocked name from its cache without logging it. So
the logs can show fewer blocks than the metric.

1. In Logs Insights, query `/flex/network/<environment>/dns-queries` for
   `firewall_rule_action = "BLOCK"` in the alarm's period. Note each `query_name` and the
   `srcaddr` it came from.
2. Find the network interface with that address. Its security group names the kind of workload:
   domain, isolated gateway or private gateway. Lambda shares an interface between functions with
   the same subnet and security group. So narrow it to one function with the functions' own logs
   at that time.
3. Decide which case it is:
   - A dependency missing from config, such as a new token host. Add it to the gateway's entry,
     reviewed like any config change, and deploy the network.
   - A misconfiguration, such as a secret naming a host that config doesn't. Fix the secret or the
     config.
   - Anything else: a name nobody expects, many unique subdomains, or labels that look like
     encoded data. Treat it as possible exfiltration, and escalate it as a security incident,
     with the query names as evidence. Don't add the name.

## The default security group

A VPC's default security group lets everything out, and lets in anything else in the group.
Anything created in the VPC without a security group gets the default group. Every workload names
its own group, but the network still empties the default group, with CDK's
`restrictDefaultSecurityGroup`. CloudFormation has no other way to remove its rules.

CDK empties the group with a function of its own. Lambda would give that function a log group of
its own making when it first writes. So `NetworkVpc` points the function's logging at a
`PlatformLogGroup` instead, `/flex/network/<environment>/restrict-default-security-group`.
`NetworkVpc` finds the function by its construct path. So if a CDK upgrade moves the function,
synth fails, rather than leaving it to log somewhere unseen.

## The caller token's keys

Gateways verify the [caller token](/flex-platform/frontdoor/caller-token/) with the edge's public
keys. The keys are in [one table](/flex-platform/frontdoor/caller-token/#the-tables) in the
environment's frontdoor account. A gateway scans the table, by its ARN, through the `dynamodb`
endpoint, whose policy names that one table.

DynamoDB offers both a gateway endpoint and an interface endpoint. The network uses the interface
endpoint, as it does for every other service. Its traffic then stays inside the VPC, to an address
the security groups and network ACLs already allow. A gateway endpoint would send the traffic to
DynamoDB's public ranges, which the network ACLs would have to let out.

DynamoDB's interface endpoint has no private DNS. AWS advises against a private hosted zone that
answers for DynamoDB's own names, since those names may change. So a gateway is given the
endpoint's own regional name, in `FLEX_CALLER_TOKEN_KEYS_ENDPOINT`, and calls it there over HTTPS.
The regional name answers with the endpoint's address in every subnet the endpoint is in.

CloudFormation lists the endpoint's names regional first, then zonal, each after its hosted zone's
ID. The network writes the first name to `/flex/network/<environment>/endpoint-address/dynamodb`,
which a gateway's stack reads. The network also allows that name on the
[allowlist](#the-allowlist).

The regional name lasts as long as the endpoint. Adding or removing one of the network's zones
changes only the zonal names, which nothing reads. An endpoint that is replaced has a new name. The
network's stack then updates the parameter and the allowlist together. Every gateway's stack must
then deploy with `--force`, as for [any ID](#ids-other-stacks-read). Until it does, the gateway
calls the old name, which the allowlist refuses.

## IDs other stacks read

AWS generates the network's IDs. So the network writes the IDs a workload needs to SSM, under
names derived from config:

| Parameter | Holds |
|---|---|
| `/flex/network/<environment>/vpc-id` | The VPC's ID |
| `/flex/network/<environment>/isolated-subnet-ids` | The isolated subnets' IDs, as a list |
| `/flex/network/<environment>/private-subnet-ids` | The private subnets' IDs, as a list |
| `/flex/network/<environment>/security-group/<workload>` | A workload's security group |
| `/flex/network/<environment>/endpoint/<service>` | An interface endpoint's ID, such as `secretsmanager`'s, for a role's `aws:SourceVpce` condition |
| `/flex/network/<environment>/endpoint-address/dynamodb` | The `dynamodb` endpoint's own regional name, which a gateway calls it at |

Each account has its own parameters, so the names need no account. A stack reads one with
`StringParameter.valueForStringParameter` or `StringListParameter.valueForTypedListParameter`.
Each becomes a CloudFormation parameter that CloudFormation resolves at deploy, so synth stays
offline. Never use `valueFromLookup`, which reads the account at synth. A test synthesizes every
stage and fails if it asked for a lookup. The planned release pipeline, which will create domain
functions outside CloudFormation, is to read the same parameters.

These IDs don't change unless the network is replaced. If one does change, a stack that reads it
must deploy with `--force`. CDK skips a stack whose template hasn't changed, and a new parameter
value doesn't change the template.
