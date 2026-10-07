export interface EdgeEnvironment {
  readonly url: string;
  /** In us-east-1, where WAF writes a CloudFront web ACL's logs. */
  readonly wafLogGroupName: string;
  readonly validPath: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    edgeEnvironment: EdgeEnvironment;
  }
}
