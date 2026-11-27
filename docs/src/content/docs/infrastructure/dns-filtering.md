---
title: DNS filtering
description: How DNS Firewall lets each network resolve only the names on its allowlist, how the allowlist is built and changed, and how to investigate a blocked query.
---

The VPC's Route 53 Resolver filters names with DNS Firewall, which denies by default. A name a
workload asks for resolves only if it is on the VPC's allowlist. The resolver answers any other
name with `NXDOMAIN`. The construct is `DnsFirewall`, in
`infra/constructs/src/network/dns-firewall.ts`.

The allowlist is VPC-wide. Every workload in the network can resolve every name on it, so it
doesn't give one gateway names that another lacks.

## Rules

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

## The allowlist

The allowlist holds the names the SDK calls each [endpoint](/flex-platform/infrastructure/network/#endpoints)'s API at, and the names
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
- Nothing for the `execute-api` endpoint itself. A [private API](/flex-platform/infrastructure/network/#private-apis) is called at its
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

## Changing the allowlist

- Add a gateway's names in the same change that deploys the gateway, or before. The network stack
  deploys before the stacks that use it.
- Remove a name only once no deployed gateway needs it. Removing a gateway from config removes its
  names, unless another gateway or the platform's baseline still lists them.
- Only the network stack's deployment changes the firewall. No workload's role has any
  `route53resolver` permission, so no workload can change its own allowlist.

## Query logs

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

## Investigating a blocked query

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
