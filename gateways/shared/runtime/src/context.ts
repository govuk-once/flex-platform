export interface DriverContext {
  attempt<T>(fn: () => Promise<T>): Promise<T>;
}

export function createDriverContext(): DriverContext {
  return {
    async attempt<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}
