export interface EdgeEnvironment {
  /** The URL the app calls, without a trailing slash. */
  readonly url: string;
  /** In us-east-1, where WAF writes a CloudFront web ACL's logs. */
  readonly wafLogGroupName: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    edgeEnvironment: EdgeEnvironment;
  }
}
