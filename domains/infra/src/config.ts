export type AccessLevel = "isolated" | "private" | "public";

export const DEFAULT_ACCESS: AccessLevel = "isolated";

export type RouteMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface RouteConfig {
  readonly method: RouteMethod;
  readonly path: string;
}

export interface FunctionConfig {
  readonly timeoutSeconds?: number;
  readonly memorySize?: number;
}

export interface DomainConfig {
  readonly name: string;
  readonly access?: AccessLevel;
  readonly function?: FunctionConfig;
  readonly routes: readonly RouteConfig[];
}

export function accessOf({
  access = DEFAULT_ACCESS,
}: DomainConfig): AccessLevel {
  return access;
}
