export function domainResourceName(domainName: string) {
  return `flex-domain-${domainName}`;
}

export function functionLogGroupName(domainName: string) {
  return `/aws/lambda/${domainResourceName(domainName)}`;
}

export function apiAccessLogGroupName(domainName: string) {
  return `/aws/apigateway/${domainResourceName(domainName)}`;
}
