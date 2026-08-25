export interface DriverDefinition<
  TOpFields extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly type: string;
  // Phantom property - gives TypeScript a structural anchor to infer TOpFields
  // from a driver instance via `OperationFields<D>`. Never set at runtime.
  readonly __opFields?: TOpFields;
}

export type OperationFields<D> =
  D extends DriverDefinition<infer F> ? F : never;
