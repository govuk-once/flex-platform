// The contract between the runtime and a driver's executor, as types only. The runtime builds
// the context; a driver's createExecutor returns the execute function.
export interface DriverContext {
  upstream<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface OperationResult<TOutcome extends string = string> {
  readonly outcome: TOutcome;
  readonly data: unknown;
}

export type ExecuteFn = (
  ctx: DriverContext,
  operation: string,
  input: unknown,
) => Promise<OperationResult>;

// The supertype of every custom handler. `never` parameters make any handler assignable to it
// whatever input it declares and whatever the driver passes after it; drivers narrow both.
export type OperationHandler = (
  input: never,
  ...context: never[]
) => Promise<OperationResult>;
