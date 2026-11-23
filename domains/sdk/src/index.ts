export { DomainConfigError } from "./check-domain.ts";
export { defineDomain } from "./define-domain.ts";
export {
  badGateway,
  badRequest,
  conflict,
  gatewayTimeout,
  internalError,
  notFound,
  tooManyRequests,
  unavailable,
  unprocessable,
} from "./failures.ts";
export type { Handler } from "./handler.ts";
export type { Register } from "./register.ts";
