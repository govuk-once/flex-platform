---
title: Network
description: The VPC in each domain account that domains and gateways run in, its tiers, endpoints and logs, and how other stacks find its IDs.
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
