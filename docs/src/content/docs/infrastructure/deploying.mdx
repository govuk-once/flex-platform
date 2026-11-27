---
title: Deploying
description: How a merge to main deploys a stage, one account at a time in waves, and why a deploy never goes back.
---

A merge to `main` deploys platform-dev through GitHub Actions, once the quality checks pass. No
person deploys from their own machine. platform-staging and platform-prod have no deploy yet.

Each account is bootstrapped for CDK in each region it deploys to:

- a frontdoor account and a shared account in us-east-1 and eu-west-2;
- a domain account in eu-west-2.

Each account trusts only itself. The platform team bootstraps the accounts, and gives each one a
role that the deploy assumes through GitHub's OIDC.

Each stage has a GitHub environment of the same name, which only `main` may deploy from. It holds
each account's role as a variable named `DEPLOY_ROLE_<account ID>`, such as
`DEPLOY_ROLE_553915472156`. If a deploy finds no variable for an account, it stops before it
deploys anything into that account.

A deploy (`.github/workflows/_deploy.yml`) synthesizes the stage once. It then deploys that cloud
assembly in waves. A stack goes in the wave after the last stack it depends on, so the order comes
from the dependencies the app records. `infra/app/bin/deploy-waves.ts` works it out.

Each wave runs one job per account, in parallel. Each job deploys only its own account's stacks,
as that account's role, with `cdk deploy --exclusively`. Without `--exclusively`, `cdk deploy`
also deploys a stack's dependencies, including those in another account, which the role can't
reach. A wave starts once every job in the wave before it has succeeded.

For platform-dev, the waves are:

| Wave | Shared account | Domain account | Frontdoor account |
|---|---|---|---|
| 1 | `shared-identity`, `shared-release` | `network-<environment>-<account>`, `domainaccount-<environment>-<account>` | `frontdoor-<environment>-edge-logs-eu-west-2`, `frontdoor-<environment>-caller-token-keys` |
| 2 | `shared-management` | `domain-<environment>-<domain>`, `gateway-<environment>-<account>-<id>` | |
| 3 | | | `frontdoor-<environment>` |

The workflow has three wave jobs. If a stage's stacks would need a fourth wave, its plan fails
before anything deploys. A test holds every stage in config to three waves. To add a wave, add a
job to the workflow and change `DEPLOY_WAVES`.

One deploy of a stage runs at a time. The others wait, oldest first.

A deploy never goes back to an older commit. Each account's job first finds the commit the stage
has, from the GitHub environment's latest successful deployment. The job fails unless its own
commit includes that commit (`infra/app/src/stage-check.ts`). A job can be run again on its own,
reusing its run's plan, so every job makes the check, not once per run. A commit can still go on
to a stage after newer commits have deployed elsewhere, as long as that stage has nothing newer.

Every account's job is a deployment of its own. So a commit counts as the stage's once any one of
its jobs succeeds, even if a later wave fails, because some of the stage's stacks now run it. What
the stage has is the newest commit any of its stacks run, not the last commit that deployed in
full. To put right a failed deploy, deploy it again or deploy a newer commit, never an older one.
