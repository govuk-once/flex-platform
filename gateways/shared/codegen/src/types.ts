export type JSONSchema = Record<string, unknown>;

export interface OperationSchemas {
  input: JSONSchema;
  outcomes: Record<string, JSONSchema>;
}

export interface GatewaySchemas {
  defs?: Record<string, JSONSchema>;
  operations: Record<string, OperationSchemas>;
}

// The wire contract owns this type. Re-exported here only so codegen's own callers need not
// reach past it.
export type { Validator } from "@repo/gateway-types";
