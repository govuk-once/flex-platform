/**
 * A bundle's key in the code bucket: under its domain, named by its own hash. So the same bundle
 * always has the same key, another bundle never has it, and a pipeline can reach only its own
 * domain's keys. The pipeline API signs uploads to it, and the release worker reads from it.
 */
export function bundleKey(domain: string, sha256: string): string {
  return `${domain}/bundle/${sha256}.zip`;
}
