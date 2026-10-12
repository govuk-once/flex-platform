export { Edge, type EdgeProps } from "./edge.ts";
export {
  accessLogsName,
  originDomainName,
  wafLogGroupName,
  webAclName,
} from "./names.ts";
export {
  CONTENT_SECURITY_POLICY,
  EdgeResponseHeadersPolicy,
} from "./response-headers-policy.ts";
export {
  ViewerRequestFunction,
  type ViewerRequestFunctionProps,
} from "./viewer-request-function.ts";
export {
  MANAGED_RULE_GROUPS,
  type ManagedRuleGroup,
  RATE_LIMIT_PER_FIVE_MINUTES,
  RATE_LIMIT_RESPONSE_CODE,
  RATE_LIMIT_RULE_NAME,
} from "./waf-rules.ts";
export { REDACTED_HEADERS, WebAcl, type WebAclProps } from "./web-acl.ts";
