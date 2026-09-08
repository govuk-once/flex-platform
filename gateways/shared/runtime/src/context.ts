// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GatewayClient {}

export interface DriverContext {
  call<T>(fn: (client: GatewayClient) => Promise<T>): Promise<T>;
}

export function createDriverContext(): DriverContext {
  const client: GatewayClient = {};
  return {
    async call<T>(fn: (client: GatewayClient) => Promise<T>): Promise<T> {
      return fn(client);
    },
  };
}
