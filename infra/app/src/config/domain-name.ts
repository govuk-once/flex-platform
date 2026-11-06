import type { DomainConfig } from "./types.ts";

/** A domain's name, whether config lists it by name or as disabled. */
export function domainName(domain: DomainConfig): string {
  return typeof domain === "string" ? domain : domain.name;
}
