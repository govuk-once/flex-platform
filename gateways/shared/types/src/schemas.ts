// Operation schemas as codegen consumes them and drivers may produce them. Shared here so a
// driver can derive schemas from its own description of an upstream without depending on codegen.
// Name the configuration's operation keys as TOperation so a missing or misnamed operation
// fails to typecheck.
export type JSONSchema = Record<string, unknown>;

export interface OperationSchemas {
  input: JSONSchema;
  outcomes: Record<string, JSONSchema>;
}

export interface GatewaySchemas<TOperation extends string = string> {
  defs?: Record<string, JSONSchema>;
  operations: Record<TOperation, OperationSchemas>;
}
