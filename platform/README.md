# Platform infrastructure

`@repo/platform` is the CDK package that deploys Flex's own infrastructure. This guide covers how the package is laid out and run, what the edge does, and what has to exist
before it can be deployed.

## Layout

```txt
platform/
  src/
    app.ts            the CDK entry point
    create-app.ts     builds the stacks for a given STAGE
    config.ts         the agreed values, one named constant each
    environment.ts    resolves the stage
    constructs/       reusable constructs; they take everything as props
    stacks/           the stacks, where a stage's values meet the constructs
  test/
    constructs/       CDK assertion tests on the constructs
    stacks/           tests that synthesise the app and inspect the result
    e2e/              integration tests, run against a deployed edge
```

Constructs are reusable. Stacks read what they need from SSM at deploy time and pass the constants in [`src/config.ts`](src/config.ts) to the constructs. The tests under `test/e2e` need a deployment and AWS credentials, so `pnpm test` excludes them; they run through `test:e2e` with their own Vitest configuration.

## Commands

From the repository root:

| Command | Does |
|---|---|
| `pnpm synth` | Synthesises the stacks for the stage in `STAGE` |
| `pnpm checkov` | Synthesises, then scans the templates with checkov |
| `pnpm --filter @repo/platform deploy` | Deploys the stage's stacks |
| `pnpm --filter @repo/platform diff` | Shows what a deploy would change |
| `pnpm --filter @repo/platform destroy` | Removes the stage's stacks |
| `pnpm --filter @repo/platform test:e2e` | Runs the integration tests against a deployed edge |

Synthesis does not need credentials, but it does need a stage and an account to write into the templates:

```bash
STAGE=development CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=eu-west-2 pnpm checkov
```

`checkov` must be installed: `python3 -m pip install checkov`. The quality checks workflow installs
a pinned version.

## Stages

`STAGE` names a deployment. It falls back to `USER`, so a developer gets a stage of their own.

| Stage | Account | On stack deletion |
|---|---|---|
| `development`, `staging`, `production` | its own | Logs are retained; stacks have termination protection |
| anything else, e.g. `pr-123` | development | Logs are removed with the stack |

A stage name is lowercased, stripped to letters, digits and hyphens, and cut to 12 characters so
the resource names built from it fit AWS limits.

## The edge

The edge is two stacks per stage. The platform runs in `eu-west-2`, but three of the edge's
resources must be created in `us-east-1` a required by CloudFront: the web ACL, the web
ACL's log destination, and the viewer certificate. Those three live in a small global stack.
Everything else, including the distribution itself, lives in the edge stack in `eu-west-2`.

| Stack | Region | Holds |
|---|---|---|
| `<stage>-FlexEdgeGlobal` | `us-east-1` | The web ACL (`EdgeWebAcl`), its log group and the viewer certificate |
| `<stage>-FlexEdge` | `eu-west-2` | The distribution (`FlexEdge`), its access log bucket, response headers policy, DNS records, parameters and outputs |

The edge stack takes the web ACL's ARN and the certificate from the global stack as CDK cross
region references. The global stack reads the hosted zone parameters, which live in `eu-west-2`,
through `CrossRegionParameter`, a small custom resource that calls `GetParameter` there.
`EdgeWebAcl` refuses any region but `us-east-1`; `FlexEdge` can be created anywhere.

### Request path

Every request is evaluated by the web ACL, then forwarded to the one origin: the API layer's
regional hostname, over HTTPS with TLS 1.2 or later, under the path in `EDGE_ORIGIN_PATH`. The
default behaviour:

- accepts every HTTP method;
- requires HTTPS from the viewer. A plain HTTP request gets a 403
- forwards every header, cookie and query string except `Host`;
- caches nothing (`CachingDisabled`).

Caching of public, non-personalised data is expected later as further behaviours with their own
cache policies, which is why these are settings on one behaviour and not on the distribution.

### TLS and DNS

Each stage is served at a name in the hosted zone the platform team delegates to the account: the
zone's own name for an environment, `<stage>.<zone>` for an ephemeral stage, so several can share
the development zone. ACM issues the certificate and validates it through DNS in that zone. A and
AAAA alias records point the name at the distribution.

The minimum viewer protocol is `EDGE_MINIMUM_TLS`, set to TLSv1.2_2021: the strictest policy
CloudFront offers, admitting TLS 1.2 and 1.3 with the 2021 cipher set.

### Web ACL

The default action is allow; the rules decide what is blocked, in this order:

| Priority | Rule | Blocks |
|---|---|---|
| 0 | `AWSManagedRulesCommonRuleSet` | OWASP top ten: cross site scripting, file inclusion, oversized bodies and the like |
| 1 | `AWSManagedRulesKnownBadInputsRuleSet` | Known exploit signatures, including Log4j JNDI lookups |
| 2 | `AWSManagedRulesSQLiRuleSet` | SQL injection in the query string, body, cookies and headers |
| 3 | `AWSManagedRulesAmazonIpReputationList` | Addresses Amazon's threat intelligence has seen attacking others |
| 4 | `RateLimitPerIp` | More than `EDGE_RATE_LIMIT_PER_FIVE_MINUTES` requests from one address in five minutes |

A managed rule responds to a blocked request with 403. The rate rule answers with 429.

Each rule publishes CloudWatch metrics under its own name in the `AWS/WAFV2` namespace,
dimensioned by the web ACL's name, and samples the requests it matches. The `authorization` and
`cookie` headers are redacted

The default rule groups are `DEFAULT_MANAGED_RULE_GROUPS` in
[`src/constructs/waf-rules.ts`](src/constructs/waf-rules.ts); a stack can pass a different list.
Note: the common rule set's `SizeRestrictions_BODY` rule blocks bodies over 8 KB. An API that
accepts larger bodies needs that rule overridden to count, which is a change in the same file.

### Logs

| Log | Where | Retention | Found via |
|---|---|---|---|
| WAF, every evaluated request | CloudWatch Logs, `us-east-1`, log group `aws-waf-logs-<stage>-flex-edge`, KMS encrypted | `EDGE_WAF_LOG_RETENTION` (90 days) | output `WafLogGroupName` on either stack |
| CloudFront access logs | S3, `eu-west-2`, prefix `cloudfront/`, S3 managed encryption, object lock in an environment | `EDGE_ACCESS_LOG_RETENTION` (90 days) | output `AccessLogBucketName` on the edge stack |

Two AWS constraints shape this. A CloudFront web ACL can log only to `us-east-1`, and only to a
log group whose name starts with `aws-waf-logs-`. CloudFront cannot deliver access logs to a KMS
encrypted bucket, or to one with ACLs disabled, so the bucket uses S3 managed encryption and
object writer ownership.

A WAF log entry records the request's CloudFront id, the same value the caller received in the
`x-amz-cf-id` response header, as `httpRequest.requestId`. The integration test finds a block by
it.

## Parameters and outputs

Both stacks read these SSM parameters from `eu-west-2` at deploy time and fail without them:

| Parameter | Written by | Holds |
|---|---|---|
| `/infra/dns/hostedzoneid` | the platform team | The id of the account's hosted zone |
| `/infra/dns/hostedzonename` | the platform team | Its name |
| `/<stage>/flex/edge/origin/domain-name` | the stack that creates the API layer | The API's regional hostname |

The edge stack writes these to `eu-west-2` for the stacks that follow:

| Parameter | Holds |
|---|---|
| `/<stage>/flex/edge/distribution-id` | The distribution's id |
| `/<stage>/flex/edge/distribution-domain-name` | Its `cloudfront.net` name |
| `/<stage>/flex/edge/url` | The URL callers use |

Outputs: the edge stack has `EdgeUrl`, `DistributionId`, `DistributionDomainName`,
`WafLogGroupName` and `AccessLogBucketName`; the global stack has `WebAclArn`,
`WafLogGroupName` and `CertificateArn`.

## Deploying

Before the first deploy to an account:

1. Bootstrap CDK in both regions: `cdk bootstrap aws://<account>/eu-west-2 aws://<account>/us-east-1`.
2. Create the three parameters above in `eu-west-2`. The hosted zone must already be delegated,
   or certificate validation never completes.
3. For the pipeline, store the OIDC deployment role's ARN in the `DEV_DEPLOYMENT_ROLE` repository
   secret. The deploy job on `main` is skipped until it exists.

`cdk deploy --all` deploys the global stack first, since the edge stack depends on it. The
pipeline deploys `main` to the development account and then runs the integration tests. A
developer deploys their own stage with `pnpm --filter @repo/platform deploy` and credentials for
the development account.

## Integration tests

`pnpm --filter @repo/platform test:e2e` reads `EdgeUrl` and `WafLogGroupName` from the stage's
edge stack, or takes them from `FLEX_EDGE_URL` and `FLEX_EDGE_WAF_LOG_GROUP`, and checks that:

- a request carrying a Log4j JNDI lookup in a header gets a 403 from CloudFront, and the WAF log
  group gains a `BLOCK` entry for its request id naming the known bad inputs rule group;
- a well formed request to `FLEX_EDGE_VALID_PATH` (default `/health`) reaches the origin and gets
  a 2xx;
- the security headers are present, and a plain HTTP request is refused.

The log check polls for up to five minutes, since delivery to CloudWatch is not immediate.

## Checkov

A check a resource knowingly does not meet is skipped on that resource through
`applyCheckovSkips`, with the reason, so the skip is reviewed beside the code that needed it.
[`checkov.yaml`](checkov.yaml) skips only the Lambda checks that CDK's own custom resource
providers cannot meet.
