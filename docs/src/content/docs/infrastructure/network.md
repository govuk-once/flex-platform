---
title: Network
description: The VPC in each domain account that domains and gateways run in, its tiers, endpoints, DNS filtering and logs, and how other stacks find its IDs.
---

Each domain account has one network in each environment, in its own stack,
`network-<environment>-<account>`, in eu-west-2. It is built for domains and gateways to run in,
and deploying either is planned. Its constructs are in `infra/constructs/src/network/`, and
`infra/app/src/stacks/network.ts` puts them together.

The network decides where a workload may send traffic. It doesn't create any workload. Each will
find the subnets and security group it runs in through
[the IDs the network writes to SSM](#ids-other-stacks-read).

## Tiers

Each availability zone has three subnets, one per tier:

| Tier | For | Route out |
|---|---|---|
| `isolated` | Domains, and gateways whose upstream is reached privately | None. Only the VPC itself, including its [interface endpoints](#endpoints) |
| `private` | Gateways whose upstream is reached over the internet | Its zone's NAT gateway |
| `public` | Only the NAT gateways | The internet gateway |

A workload's tier is its [placement](/flex-platform/reference/glossary/#placement). No subnet gives
anything in it a public IP address. AWS Network Firewall is planned for the private tier.

### Availability zones

Each domain account lists its availability zones in config, as `network.availabilityZones`:
platform-dev and platform-staging use `eu-west-2a` and `eu-west-2b`, and the environments in
platform-prod use all three. Each zone listed has its own NAT gateway, which is most of what a zone
costs. Config must list at least two zones, each one only once, and only eu-west-2's.

Every subnet's range is fixed by its zone, not its position in the list:

| Block | Holds |
|---|---|
| `10.0.0.0/18` | `isolated`, a `/20` per zone, one spare |
| `10.0.64.0/18` | `private`, a `/20` per zone, one spare |
| `10.0.128.0/22` | `public`, a `/24` per zone |
| `10.0.132.0/24` | Reserved for AWS Network Firewall, a `/28` per zone. Nothing is created in it yet |

So adding or removing a zone never changes another zone's subnets, and the order config lists them
in changes nothing. A subnet whose range changed would be replaced, and so would everything in it.
The layout is `ZONE_LAYOUT` in `infra/constructs/src/network/layout.ts`, and a test checks that no
two blocks overlap. Every account uses `10.0.0.0/16`: nothing peers with another network, so
accounts may overlap.

CDK's `Vpc` checks its zones against its stack's, and a stack that doesn't name its own looks them
up in the account at synth. So the network's stack names its zones by overriding
`availabilityZones`, and `NetworkVpc` refuses a stack that doesn't.

## What a workload may reach

Every workload runs in a security group of its kind, which lets nothing in, and lets traffic out
only on TCP port 443:

| Workload | Tier | May reach |
|---|---|---|
| `domain` | `isolated` | The `lambda` endpoint |
| `isolated-gateway` | `isolated` | The `secretsmanager` and `sts` endpoints |
| `private-gateway` | `private` | The `secretsmanager` and `sts` endpoints, and its zone's NAT gateway |

A domain uses the `lambda` endpoint to invoke gateways. A gateway uses `secretsmanager` to read its
secret, and `sts` to assume an upstream's role for
[`sigV4`](/flex-platform/drivers/openapi-rest/authentication/). Each endpoint's own security group
lets in only the workloads that may reach it, and lets nothing out. What a workload may call is its
role's to decide: an endpoint's policy applies to the requests sent through that endpoint.

The rules between a workload's group and an endpoint's are written out by `WorkloadSecurityGroup`,
rather than with CDK's `connections`, which would name each rule after the other group's construct
path, stack name included, and would drop the rule CDK uses to keep EC2's default allow-all egress
off a group with no other.

### Endpoints

The isolated subnets reach AWS through interface endpoints, each with private DNS, so the SDK's
usual hostname resolves to the endpoint. Each endpoint's policy refuses any principal or resource
outside the account, and any action but its own:

| Endpoint | Allows |
|---|---|
| `lambda` | `lambda:InvokeFunction` on `gateway-<environment>-*`, any qualifier included |
| `secretsmanager` | `secretsmanager:GetSecretValue` |
| `sts` | `sts:AssumeRole` |

The `lambda` endpoint's pattern comes from `gatewayFunctionPattern` in `gateways/infra`, which
names gateways' functions. Any function in the account with that prefix can be invoked by every
domain in the environment, so the gateways section gives it to gateways alone.

An endpoint costs the same whether it's used or not, so one is added when something calls its API.
Tracing needs none: Lambda's X-Ray daemon sends from outside the VPC, so neither the X-Ray SDK nor
an OpenTelemetry exporter sending to it over UDP does. An exporter sending to X-Ray over HTTPS
would need an `xray` endpoint.

### NAT addresses

A private gateway's requests leave from its zone's NAT gateway, so an upstream that allowlists
callers allowlists those addresses. Each is an elastic IP under `NatAddresses`, retained, so it
survives the stack. The stack outputs each zone's address, such as `NatAddresseuwest2a`.

Each NAT gateway has two alarms, set as CloudWatch's recommended alarms for NAT gateways set them:

- `network-<environment>-nat-<zone>-port-allocation`: the gateway couldn't give a new connection a
  source port, every minute for 15 minutes. Too many connections are open to one destination.
- `network-<environment>-nat-<zone>-dropped-packets`: it dropped more than 0.01% of its packets,
  every minute for 5 minutes. Check AWS Health for NAT gateways in the region.

### Network ACLs

Each tier also has a network ACL, under the security groups, that holds it to its purpose whatever
a security group allows:

| Rule | Tiers | Direction | Peer | Traffic | Action |
|---|---|---|---|---|---|
| 100 | All | In and out | The VPC | All | Allow |
| 110 | All | In | Anywhere | TCP 0 to 1023 | Deny |
| 111 | All | In | Anywhere | UDP 0 to 1023 | Deny |
| 200 | `private`, `public` | Out | Anywhere | TCP 443 | Allow |
| 200 | `private`, `public` | In | Anywhere | TCP 1024 to 65535 | Allow |

A network ACL applies the lowest-numbered rule that matches, and denies what none matches. It
keeps no state, so a reply is let in by its port alone, which is why rule 200 lets in every port
from 1024 up: a NAT gateway or Lambda may take any of them for a connection, so no rule before it
refuses one. Rules 110 and 111 only state what the final deny already does.

## Flow logs

Every flow in the VPC, accepted and rejected, goes to a bucket of the network stack's, as plain
text in Hive-style hourly partitions, so Athena can read a window without scanning the rest. A
connection kept open is one record per direction, on each network interface it crosses, every ten
minutes, AWS's default.

They go to S3 rather than CloudWatch Logs because they are the platform's largest log by far. S3's
delivery costs half as much, and the logs stay out of log forwarding, which would index every
record. The bucket is a `PlatformBucket`, locked for a year. Each log moves to S3 Glacier Instant
Retrieval after 30 days and is deleted after a year, as long as log groups are kept. Until then,
every version of it is kept, however it was overwritten or deleted.

The rejected flows alone also go to a `PlatformLogGroup`, `/flex/network/<environment>/rejected-flows`,
through a second flow log. A rejection is the security signal in a flow log, something
misconfigured or probing, and there should be few, so these are the flows log forwarding is to carry
to the central logs, without the cost of indexing every flow. Forwarding is planned.

## DNS filtering

The VPC's Route 53 Resolver filters names with DNS Firewall, which denies by default: a name a
workload asks for resolves only if it is on the VPC's allowlist, and anything else is answered
`NXDOMAIN`. The
construct is `DnsFirewall`, in `infra/constructs/src/network/dns-firewall.ts`.

The allowlist is VPC-wide. Every workload in the network can resolve every name on it, so it
doesn't give one gateway names another lacks.

### Rules

| Association priority | Rule group | Rule |
|---|---|---|
| 1000 | `network-<environment>-dns-allow` | Allow the names on `network-<environment>-dns-allowed` |
| 9000 | `network-<environment>-dns-block` | Block every name, `*`, for every query type, with `NXDOMAIN` |

The lower priority is evaluated first. The block is a rule group of its own, which no change to the
allowlist touches. The allowlist is a domain list that the allow group's one rule names, so adding
or removing a name changes that list and nothing else. An update or rollback of the
allowlist never takes the block away, even for a moment.

The allow rule trusts redirection. How an upstream serves its name, such as which CDN it is behind,
is the upstream's to change, so config lists only the names a gateway connects to.

If DNS Firewall can't evaluate a query, the resolver answers `SERVFAIL`: the VPC fails closed.
That's AWS's default, but it's set explicitly, with an `AWS::Route53Resolver::FirewallConfig`, so a
test and a reviewer can see it. aws-cdk-lib has no typed class for that resource yet, so the
construct declares it as a `CfnResource`.

### The allowlist

The allowlist is the names the SDK calls each [endpoint](#endpoints)'s API at, and the names every
gateway in the domain account declares:

- `lambda.eu-west-2.amazonaws.com`, `secretsmanager.eu-west-2.amazonaws.com` and
  `sts.eu-west-2.amazonaws.com`, which private DNS answers with the endpoints' addresses. Another
  AWS name is added only when a workload is shown to need it. A suffix such as `*.amazonaws.com`
  never is.
- Each gateway's names, from its entry in `gateways` on its domain account in
  [config](/flex-platform/infrastructure/overview/#config): the names it connects to, its
  upstream's API and any host it takes a token from.

```ts
gateways: [
  {
    id: "udp",
    hostnames: ["api.udp.example", "auth.udp.example"],
  },
],
```

Config is per environment, so an environment's gateways can use their own names. Every entry is
checked when any stage is built, and the allowlist is lowercased, without repeats, and sorted, so
the order config lists names in changes nothing. An entry is refused if it is:

- a URL, or has a path, a query, a user or a port;
- an IP address;
- a wildcard;
- malformed: a label that isn't letters, digits and hyphens, a name of one label, or one longer
  than 253 characters. An internationalised name is written in its `xn--` form.

Every name is exact. A wildcard can match names its upstream doesn't control, so none is admitted.

A name gets onto the allowlist only through config. Nothing adds a name from a request, a DNS
failure or a secret. If a gateway reads its upstream's address from its secret, that address's
hostname must be in config too, or the gateway can't resolve it.

### Changing the allowlist

- Add a gateway's names in the same change that deploys it, or before. The network stack deploys
  before the stacks that use it.
- Remove a name only once no deployed gateway needs it. Removing a gateway from config removes its
  names, unless another gateway or the platform's baseline still lists them.
- Only the network stack's deployment changes the firewall. No workload's role is given any
  `route53resolver` permission, so no workload can change its own allowlist.

### Query logs

Resolver query logging is enabled for the VPC, to a `PlatformLogGroup`,
`/flex/network/<environment>/dns-queries`. Each record holds the name, its type, the answer, the
address it came from, and DNS Firewall's decision and the rule that made it. VPC Flow Logs don't
see this traffic. A resource policy of the stack's own lets only this account's log delivery write
to the group.

Resolver doesn't log a query it answers from its cache. The logs show which names were asked for,
not how often, and a name asked for again within its answer's TTL may not appear. A test that looks
for its query in the logs uses a name no earlier query has asked for.

A query name can carry data a workload is trying to send out, so these logs are as sensitive as
anything the platform holds. They are encrypted with the stack's log group key, so reading them
takes that key as well as the group. Log forwarding to the central logs is planned.

### Investigating a blocked query

The alarm `network-<environment>-dns-blocked-queries` goes off when DNS Firewall blocks any query in
a five-minute period. A workload's every legitimate name is on the allowlist, so any block is
unexpected. DNS Firewall's metrics arrive several minutes late, so the alarm can go
off up to about ten minutes after the query. A blocked name a workload asks for again may be
answered from Resolver's cache and not logged, so the logs can show fewer blocks than the metric.

1. In Logs Insights, query `/flex/network/<environment>/dns-queries` for
   `firewall_rule_action = "BLOCK"` in the alarm's period. Note each `query_name` and the
   `srcaddr` it came from.
2. Find the network interface with that address. Its security group names the kind of workload:
   domain, isolated gateway or private gateway. Lambda shares an interface between functions with
   the same subnet and security group, so narrow it to a function with the functions' own logs at
   that time.
3. Decide which it is:
   - a dependency missing from config, such as a new token host.
     Add it to the gateway's entry, reviewed like any config change, and deploy the network;
   - a misconfiguration, such as a secret naming a host config doesn't. Fix the secret or the
     config;
   - anything else: a name nobody expects, many unique subdomains, or labels that look like
     encoded data. Treat it as possible exfiltration, and escalate it as a security incident,
     with the query names as evidence. Don't add the name.

## The default security group

A VPC's default security group lets everything out, and lets in anything else in the group.
Anything created in the VPC without a security group gets it. Every workload names its own, but the
default group is still emptied, with CDK's `restrictDefaultSecurityGroup`. CloudFormation has no
other way to remove its rules.

CDK does that with a function of its own, which Lambda would give a log group of its own making
when it first writes. `NetworkVpc` points that function's logging at a `PlatformLogGroup`,
`/flex/network/<environment>/restrict-default-security-group`, instead. It finds the function by
its construct path, so a CDK upgrade that moves it fails synth rather than leaving it to log
somewhere unseen.

## IDs other stacks read

AWS generates the network's IDs, so the network writes the ones a workload needs to SSM, under
names derived from config:

| Parameter | Holds |
|---|---|
| `/flex/network/<environment>/vpc-id` | The VPC's ID |
| `/flex/network/<environment>/isolated-subnet-ids` | The isolated subnets' IDs, as a list |
| `/flex/network/<environment>/private-subnet-ids` | The private subnets' IDs, as a list |
| `/flex/network/<environment>/security-group/<workload>` | A workload's security group |

Each account has its own parameters, so the names need no account. A stack reads one with
`StringParameter.valueForStringParameter` or `StringListParameter.valueForTypedListParameter`.
Each becomes a CloudFormation parameter that CloudFormation resolves at deploy, so synth stays
offline. Never `valueFromLookup`, which reads the account at synth. A test synthesizes every stage
and fails if it asked for a lookup. The planned release pipeline, which will create domain
functions outside CloudFormation, is to read the same parameters.

These IDs don't change unless the network is replaced. If one does, a stack that reads it deploys
with `--force`: CDK skips a stack whose template hasn't changed, and a new parameter value doesn't
change the template.
