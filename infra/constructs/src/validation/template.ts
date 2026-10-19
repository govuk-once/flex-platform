import { readFileSync } from "node:fs";

// Reading a synthesized CloudFormation template. Every value comes from a file, so each is
// `unknown` until a check has looked at it.

export interface TemplateResource {
  readonly Type?: string;
  readonly DeletionPolicy?: string;
  readonly Properties?: Readonly<Record<string, unknown>>;
}

export type TemplateResources = Readonly<Record<string, TemplateResource>>;

export interface PolicyStatement {
  readonly Effect?: unknown;
  readonly Principal?: unknown;
  readonly Action?: unknown;
  readonly Resource?: unknown;
  readonly Condition?: unknown;
}

export function readResources(templatePath: string): TemplateResources {
  const { Resources = {} } = JSON.parse(readFileSync(templatePath, "utf8")) as {
    Resources?: TemplateResources;
  };
  return Resources;
}

/** `{ "Fn::GetAtt": [logicalId, attribute] }`, as CDK writes a reference to an attribute. */
export function getAtt(logicalId: string, attribute: string): unknown {
  return { "Fn::GetAtt": [logicalId, attribute] };
}

/** Whether a value is `{ "Ref": logicalId }`. */
export function refersTo(value: unknown, logicalId: string): boolean {
  return (value as { Ref?: unknown } | undefined)?.Ref === logicalId;
}

/**
 * Every statement of every policy of `policyType` attached to a resource, where the policy names
 * the resource by `Ref` in its `targetProperty`, such as an `AWS::S3::BucketPolicy`'s `Bucket`.
 */
export function attachedPolicyStatements(
  template: TemplateResources,
  logicalId: string,
  policyType: string,
  targetProperty: string,
): PolicyStatement[] {
  return Object.values(template).flatMap((resource) => {
    if (resource.Type !== policyType) return [];
    if (!refersTo(resource.Properties?.[targetProperty], logicalId)) return [];
    const statements = (
      resource.Properties?.PolicyDocument as { Statement?: unknown } | undefined
    )?.Statement;
    return Array.isArray(statements) ? (statements as PolicyStatement[]) : [];
  });
}

/** Whether a statement's principal is anyone: `"*"` or `{ "AWS": "*" }`. */
export function isAnyone(principal: unknown): boolean {
  return (
    principal === "*" ||
    (principal as { AWS?: unknown } | undefined)?.AWS === "*"
  );
}

/** Whether a statement's action is, or includes, `action`. */
export function hasAction(statement: PolicyStatement, action: string): boolean {
  const actions = statement.Action;
  return (
    actions === action || (Array.isArray(actions) && actions.includes(action))
  );
}

/** Whether a statement's resource is, or includes, each of `resources`, compared as written. */
export function coversResources(
  statement: PolicyStatement,
  resources: readonly unknown[],
): boolean {
  const written = (
    Array.isArray(statement.Resource)
      ? statement.Resource
      : [statement.Resource]
  ).map((resource) => JSON.stringify(resource));
  return resources.every((resource) =>
    written.includes(JSON.stringify(resource)),
  );
}

/**
 * The value of a statement's condition when that condition is one operator and key and nothing
 * else, such as `Bool` and `aws:SecureTransport`. Conditions are ANDed, so any other narrows the
 * statement: a denial that also names a principal, or that holds two protections at once, applies
 * only where all of them match.
 */
export function soleCondition(
  statement: PolicyStatement,
  operator: string,
  key: string,
): unknown {
  const keys = soleEntry(statement.Condition, operator);
  return soleEntry(keys, key);
}

function soleEntry(object: unknown, name: string): unknown {
  if (typeof object !== "object" || object === null) return undefined;
  const names = Object.keys(object);
  return names.length === 1 && names[0] === name
    ? (object as Record<string, unknown>)[name]
    : undefined;
}
