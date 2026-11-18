import { checkDomain } from "./check-domain.ts";
import type { RefinedRoutes } from "./refine.ts";
import type { DomainConfig, DomainRoutes } from "./types.ts";

// TypeScript infers Routes from the plain DomainConfig side, and the argument must also satisfy
// each route refined against its key. NoInfer keeps that second side out of inference, which
// would otherwise be inferring Routes from checks built on Routes.
//
// The configuration is checked here, as it is defined, so importing a domain's module is loading
// its configuration: a test, a CI command and a cold start all fail on the same problems.
export function defineDomain<const Routes extends DomainRoutes>(
  config: DomainConfig<Routes> & {
    readonly routes: NoInfer<RefinedRoutes<Routes>>;
  },
): DomainConfig<Routes> {
  checkDomain(config);

  return config;
}
