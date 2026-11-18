// A release's ID: a UUID of version 7, made with `uuidV7` from `@repo/utils`, whose first 48 bits
// are the time it was made. So IDs sort as text in the order they were made, which lets the table
// list a domain's releases newest first, and lets `live` refuse a release asked for before the
// one it holds by comparing IDs.

const RELEASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isReleaseId(value: string): boolean {
  return RELEASE_ID.test(value);
}
