import { isPlatformName } from "@repo/utils/is-platform-name";

import type { DomainConfig, FunctionConfig } from "./config.ts";
import { FUNCTION_LIMITS } from "./function.ts";
import type { EnvironmentNameOptions } from "./names.ts";
import { domainResourceName, RESOURCE_NAME_LENGTH } from "./names.ts";

const LITERAL_SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const PARAMETER_SEGMENT = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const GREEDY_SEGMENT = /^\{[^}]*\+\}$/;

interface RouteCheckOptions {
  readonly routeDescription: string;
}

interface SiblingParameterOptions extends RouteCheckOptions {
  readonly parameterUnderPath: Map<string, string>;
}

export function validateDomain(
  domain: DomainConfig,
  options: EnvironmentNameOptions,
): void {
  checkName(domain);
  checkResourceName(domain, options);
  checkRoutes(domain);
  checkFunction(domain);
}

function checkName({ name }: DomainConfig): void {
  if (!isPlatformName(name)) {
    throw new Error(
      `The domain name ${JSON.stringify(name)} must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen`,
    );
  }
}

// The function and its role share the name, and both are limited to 64 characters.
function checkResourceName(
  { name }: DomainConfig,
  options: EnvironmentNameOptions,
): void {
  const resourceName = domainResourceName(name, options);

  if (resourceName.length > RESOURCE_NAME_LENGTH) {
    throw new Error(
      `${name} domain: its resource name, ${resourceName}, is longer than the ${RESOURCE_NAME_LENGTH} characters Lambda and IAM allow`,
    );
  }
}

function checkFunction({ name, function: settings = {} }: DomainConfig): void {
  for (const [field, { min, max }] of Object.entries(FUNCTION_LIMITS)) {
    const value = settings[field as keyof FunctionConfig];

    if (value === undefined) continue;

    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(
        `${name} domain function ${field} must be a whole number from ${min} to ${max}`,
      );
    }
  }
}

function checkRoutes(domain: DomainConfig): void {
  if (domain.routes.length === 0) {
    throw new Error(`${domain.name} domain has no routes`);
  }

  const routes = new Set<string>();
  const parameterUnderPath = new Map<string, string>();

  for (const route of domain.routes) {
    const routeKey = `${route.method} ${route.path}`;
    const routeDescription = `${domain.name} domain route "${routeKey}"`;

    const segments = validatedPathSegments(route.path, { routeDescription });

    if (routes.has(routeKey)) {
      throw new Error(`"${routeKey}" can only be declared once`);
    }

    routes.add(routeKey);

    checkSiblingParameters(segments, { parameterUnderPath, routeDescription });
  }
}

function validatedPathSegments(
  path: string,
  { routeDescription }: RouteCheckOptions,
): string[] {
  if (!path.startsWith("/")) {
    throw new Error(`${routeDescription}: the path must start with "/"`);
  }

  if (path === "/") return [];

  const segments = path.slice(1).split("/");
  const pathParameters = new Set<string>();

  for (const segment of segments) {
    if (segment === "") {
      throw new Error(
        `${routeDescription}: the path has an empty segment, from a trailing or doubled "/"`,
      );
    }

    if (GREEDY_SEGMENT.test(segment)) {
      throw new Error(
        `${routeDescription}: ${segment} would answer every path below it. Declare each path instead`,
      );
    }

    if (PARAMETER_SEGMENT.test(segment)) {
      if (pathParameters.has(segment)) {
        throw new Error(
          `${routeDescription}: the parameter ${segment} appears twice`,
        );
      }

      pathParameters.add(segment);
    } else if (!LITERAL_SEGMENT.test(segment)) {
      throw new Error(
        `${routeDescription}: ${JSON.stringify(segment)} is not a valid path segment`,
      );
    }
  }

  return segments;
}

// API Gateway allows one parameter name per position in the path tree, so /a/{id} beside
// /a/{aId}/b fails, but only at deploy.
function checkSiblingParameters(
  segments: readonly string[],
  { parameterUnderPath, routeDescription }: SiblingParameterOptions,
): void {
  for (const [index, segment] of segments.entries()) {
    if (!PARAMETER_SEGMENT.test(segment)) continue;

    const parentPath = `/${segments.slice(0, index).join("/")}`;
    const existingParameter = parameterUnderPath.get(parentPath);

    if (existingParameter !== undefined && existingParameter !== segment) {
      throw new Error(
        `${routeDescription}: ${segment} sits beside ${existingParameter} under ${parentPath}, and API Gateway allows one parameter name there`,
      );
    }

    parameterUnderPath.set(parentPath, segment);
  }
}
