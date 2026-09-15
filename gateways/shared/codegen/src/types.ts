export type JSONSchema = Record<string, unknown>;

export interface OperationSchemas {
  input: JSONSchema;
  outcomes: Record<string, JSONSchema>;
}

export interface GatewaySchemas {
  defs?: Record<string, JSONSchema>;
  operations: Record<string, OperationSchemas>;
}
