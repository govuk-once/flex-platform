// A name in the platform's config: a stage, an environment, a domain account or a domain. Each
// becomes part of resource names and DNS labels, so it is a lowercase DNS label, narrowed: it
// starts with a letter, as a CloudFormation stack name must, and is at most 32 characters, so
// names built from several of these stay within AWS's limits, such as 64 characters for an IAM
// role.
//
// The CloudFront Function bundles this to check a request's domain, so it keeps to what the
// cloudfront-js-2.0 runtime has.
const PLATFORM_NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isPlatformName(name: string): boolean {
  return PLATFORM_NAME.test(name);
}
