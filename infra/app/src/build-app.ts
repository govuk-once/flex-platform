import { ORIGIN_REQUEST_LOG_REGION } from "@repo/frontdoor-infra";
import {
  ApiIamCheck,
  BucketHttpsCheck,
  LogGroupCheck,
} from "@repo/infra-constructs";
import type { App } from "aws-cdk-lib";
import { Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

import { domainName } from "./config/domain-name.ts";
import type { Target } from "./config/select-target.ts";
import type { StageConfig } from "./config/types.ts";
import { gatewayBundle } from "./gateway-bundle.ts";
import { DomainStack } from "./stacks/domain.ts";
import { DomainAccountStack } from "./stacks/domain-account.ts";
import { FrontdoorStack } from "./stacks/frontdoor.ts";
import { FrontdoorEdgeLogsStack } from "./stacks/frontdoor-edge-logs.ts";
import { FrontdoorCallerTokenKeysStack } from "./stacks/frontdoor-keys.ts";
import { GatewayStack } from "./stacks/gateway.ts";
import { NetworkStack } from "./stacks/network.ts";
import { StackTags } from "./tags.ts";

export function buildApp(app: App, stage: StageConfig, target: Target): void {
  // Everything that applies to the whole app: the synth checks, and the one aspect. Add any other
  // here.
  Validations.of(app).addPlugins(
    new AwsSolutionsChecks(app, { verbose: true }),
    new LogGroupCheck(),
    new BucketHttpsCheck(),
    new ApiIamCheck(),
  );
  Aspects.of(app).add(new StackTags(stage));

  for (const environment of target.environments) {
    const edgeLogs = new FrontdoorEdgeLogsStack(
      app,
      environment,
      ORIGIN_REQUEST_LOG_REGION,
    );
    const frontdoor = new FrontdoorStack(app, environment);

    frontdoor.addStackDependency(
      edgeLogs,
      "The edge's Lambda@Edge role attaches the policy the edge logs stack creates, to write to its log group.",
    );

    frontdoor.addStackDependency(
      new FrontdoorCallerTokenKeysStack(app, environment),
      "The edge signs the caller token with the key key rotation makes, and decrypts it with the signing key.",
    );

    for (const domainAccount of environment.domainAccounts) {
      const network = new NetworkStack(app, { environment, domainAccount });

      for (const gateway of domainAccount.gateways) {
        const gatewayStack = new GatewayStack(app, {
          environment,
          domainAccount,
          gateway,
          bundle: gatewayBundle(gateway.id),
        });

        gatewayStack.addStackDependency(
          network,
          "The gateway reads its placement's subnets and security group, and the endpoints' IDs, from SSM.",
        );
      }

      const account = new DomainAccountStack(app, {
        environment,
        domainAccount,
      });

      // Disabled domains too: a disabled domain keeps its stack, and only loses its route.
      for (const domain of domainAccount.domains) {
        const domainStack = new DomainStack(app, {
          environment,
          domainAccount,
          domain: domainName(domain),
        });

        domainStack.addStackDependency(
          account,
          "The domain's host reads the account's certificate ARN from SSM, and its stage logs through the account's API Gateway logging setting.",
        );

        domainStack.addStackDependency(
          network,
          "The domain's deploy role reads the network's isolated subnets and domain security group from SSM.",
        );

        frontdoor.addStackDependency(
          domainStack,
          "The edge routes to every domain's host, which must exist before it does.",
        );
      }
    }
  }
}
