/**
 * Where a domain's function runs, and so what it can reach:
 *
 * - `isolated`: the VPC's isolated subnets, with no route to the internet.
 * - `private`: the VPC's private subnets, which reach the internet through NAT.
 * - `public`: outside the VPC.
 */
export type AccessLevel = "isolated" | "private" | "public";

export const DEFAULT_ACCESS: AccessLevel = "isolated";
