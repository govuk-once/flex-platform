// Never a key a domain uses. It keeps the empty interface below from accepting any object.
declare const UNREGISTERED: unique symbol;

/**
 * Where a domain registers its configuration, so a handler can be typed by its route's key:
 *
 * ```ts
 * declare module "@govuk-once/flex-domain-sdk" {
 *   interface Register {
 *     readonly domain: typeof domain;
 *   }
 * }
 * ```
 *
 * A domain's repository holds one domain, so it registers once. A second configuration in the same
 * program, such as one a test builds, cannot register too: its handlers are typed by the registered
 * routes and held only to its keys, so give it the registered routes' own schemas.
 */
export interface Register {
  readonly [UNREGISTERED]?: never;
}

// An empty record before a domain registers, so no key is accepted until then.
export type RegisteredRoutes = Register extends {
  readonly domain: { readonly routes: infer Routes };
}
  ? Routes
  : Record<never, never>;

export type RegisteredRouteKey = Extract<keyof RegisteredRoutes, string>;
