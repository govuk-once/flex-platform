import type {
  IPolicyValidationContext,
  IPolicyValidationPlugin,
  PolicyValidationPluginReport,
  PolicyViolatingResource,
} from "aws-cdk-lib";

import {
  readResources,
  type TemplateResource,
  type TemplateResources,
} from "./template.ts";

export interface ResourceRule {
  /** The rule's ID, which a finding is reported under. */
  readonly name: string;
  readonly description: string;
  readonly fix: string;
  /** The CloudFormation type the rule applies to, such as `AWS::S3::Bucket`. */
  readonly type: string;
  /** The locations at fault in one resource, none if it meets the rule. */
  readonly faults: (
    resource: TemplateResource,
    logicalId: string,
    template: TemplateResources,
  ) => readonly string[];
}

/**
 * A synth check that holds every resource of one type, in every template, to one rule. A check
 * rejects; it never fixes. Each rule has a construct that meets it, which its `fix` names.
 */
export abstract class ResourceCheck implements IPolicyValidationPlugin {
  public readonly name: string;
  public readonly ruleIds: string[];

  protected constructor(private readonly rule: ResourceRule) {
    this.name = rule.name;
    this.ruleIds = [rule.name];
  }

  public validate(
    context: IPolicyValidationContext,
  ): PolicyValidationPluginReport {
    const { name: ruleName, description, fix, type, faults } = this.rule;
    const violatingResources: PolicyViolatingResource[] = [];
    for (const templatePath of context.templatePaths) {
      const template = readResources(templatePath);
      for (const [resourceLogicalId, resource] of Object.entries(template)) {
        if (resource.Type !== type) continue;
        const locations = faults(resource, resourceLogicalId, template);
        if (locations.length > 0) {
          violatingResources.push({
            resourceLogicalId,
            templatePath,
            locations: [...locations],
          });
        }
      }
    }
    return violatingResources.length === 0
      ? { success: true, violations: [] }
      : {
          success: false,
          violations: [{ ruleName, description, fix, violatingResources }],
        };
  }
}
