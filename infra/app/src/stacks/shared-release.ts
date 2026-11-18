import { CrossRegionParameters } from "@repo/infra-constructs";
import {
  CI_ORIGIN_HOST_PARAMETER,
  CiFunction,
  CROSS_REGION_WRITER_LOG_GROUP_NAME,
  DomainCodeBucket,
  domainCodeBucketName,
  MANAGEMENT_REGION,
  SHARED_REGION,
} from "@repo/shared-infra";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import { domainNames } from "../config/domain-name.ts";
import { functionReaders } from "../config/release-targets.ts";
import type { StageConfig } from "../config/types.ts";

// One per stage, in the stage's own shared account, so the name holds no stage.
export const SHARED_RELEASE_STACK_NAME = "shared-release";

/**
 * The stage's pipeline API: its function, the URL CloudFront reaches it at, and the bucket a
 * domain's uploaded code is kept in. AWS generates the URL's host here, and the distribution is
 * in us-east-1, so the stack writes the host to a parameter there for the distribution's stack to
 * read.
 *
 * The function is built with the stage's domains and the repository each is released from, so a
 * change to who may release a domain is a deploy of this stack.
 */
export class SharedReleaseStack extends Stack {
  constructor(scope: Construct, stage: StageConfig) {
    super(scope, SHARED_RELEASE_STACK_NAME, {
      description:
        "Flex pipeline API, which a domain's pipeline releases through",
      env: { account: stage.shared.account, region: SHARED_REGION },
      terminationProtection: true,
    });

    const codeBucketName = domainCodeBucketName(stage.shared.account);

    const ci = new CiFunction(this, "Ci", {
      zoneName: stage.shared.zone.name,
      codeBucketName,
      // A disabled domain too: its code can be released while nothing is routed to it.
      environments: stage.environments.map((environment) => ({
        name: environment.name,
        publishes: environment.release === "publish",
        domains: domainNames(environment),
      })),
      // A domain with no repository yet has no entry, so nothing can release it.
      domains: stage.domains.flatMap(({ name, repository }) =>
        repository === null
          ? []
          : [
              {
                name,
                repositoryId: repository.id,
                ownerId: repository.ownerId,
              },
            ],
      ),
    });
    new DomainCodeBucket(this, "Code", {
      bucketName: codeBucketName,
      writerRoleArn: ci.role.roleArn,
      functionReaders: functionReaders(stage),
    });

    new CrossRegionParameters(this, "CrossRegion", {
      logGroupName: CROSS_REGION_WRITER_LOG_GROUP_NAME,
      parameters: {
        [MANAGEMENT_REGION]: { [CI_ORIGIN_HOST_PARAMETER]: ci.urlHost },
      },
    });
  }
}
