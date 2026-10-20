// Which domain a request is for, and where its API is. The CloudFront Function has already held
// the path to `/app/<domain>/...`, with `<domain>` a platform name and no empty or dot segment.

export interface Route {
  /** The domain's name, from the config, so safe to log. */
  readonly domain: string;
  /** The domain's API host. */
  readonly host: string;
  /** The path the domain sees: what followed `/app/<domain>`, from its root. */
  readonly path: string;
}

/** A `Map`, because the domain comes from the caller and an object lookup finds inherited members. */
export type Routes = ReadonlyMap<string, string>;

const PREFIX = "/app/";

export function routeFor(uri: string, routes: Routes): Route | undefined {
  if (!uri.startsWith(PREFIX)) return undefined;
  const rest = uri.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  const host = routes.get(name);
  if (host === undefined) return undefined;
  return {
    domain: name,
    host,
    path: slash === -1 ? "/" : rest.slice(slash),
  };
}
