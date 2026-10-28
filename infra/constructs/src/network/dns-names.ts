import { sortedNames } from "@repo/utils/sorted-names";

// The longest name DNS allows, without the trailing dot.
const MAX_NAME_LENGTH = 253;

// A label of a hostname: letters, digits and hyphens, not starting or ending with a hyphen. An
// internationalised name is written in its ASCII form, `xn--`.
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * An exact hostname, lowercased and without a trailing dot. Throws on anything that isn't one: a
 * URL, a path, a port, an IP address, a wildcard, or a malformed name. Only a name passes, so a
 * value copied from the wrong place never widens what the allowlist admits.
 */
export function exactHostname(entry: string): string {
  const refuse = (why: string): never => {
    throw new Error(`${JSON.stringify(entry)} is not a hostname: ${why}`);
  };
  if (/\s/.test(entry)) refuse("it contains whitespace");
  if (entry.includes("://")) refuse("it is a URL; give its hostname alone");
  if (/[/?#@]/.test(entry))
    refuse("it has a path, query or user; give the hostname alone");
  if (/[:[\]]/.test(entry)) refuse("it has a port or is an IPv6 address");
  // No count of labels makes a wildcard safe: `*.execute-api.eu-west-2.amazonaws.com` is deep, and
  // matches every customer's API Gateway in the region.
  if (entry.includes("*")) refuse("it is a wildcard; list each name exactly");

  const name = entry.toLowerCase().replace(/\.$/, "");
  if (name.length === 0) refuse("it is empty");
  if (name.length > MAX_NAME_LENGTH) {
    refuse(`it is longer than ${MAX_NAME_LENGTH} characters`);
  }
  const labels = name.split(".");
  if (labels.length < 2) refuse("it needs at least two labels");
  for (const label of labels) {
    if (!LABEL.test(label))
      refuse(`${JSON.stringify(label)} is not a valid label`);
  }
  // A top-level domain always has a letter, so a name ending in digits is an address.
  if (!/[a-z]/.test(labels.at(-1)!)) refuse("it is an IP address");
  return name;
}

/** Every name, checked, normalised, without repeats and in one order, so synth is reproducible. */
export function dnsAllowlist(hostnames: readonly string[]): string[] {
  return sortedNames(new Set(hostnames.map(exactHostname)));
}
