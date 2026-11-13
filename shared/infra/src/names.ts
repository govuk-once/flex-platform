// Names in the shared account. A stage has one shared account, and deploys only to its own
// accounts, so a name here holds neither a stage nor an environment:
//
//   shared-{thing}    a resource, such as the test user pool and its client, shared-test-users

/** The shared account's stacks are in the platform's home region. */
export const SHARED_REGION = "eu-west-2";

export const TEST_USER_POOL_NAME = "shared-test-users";
