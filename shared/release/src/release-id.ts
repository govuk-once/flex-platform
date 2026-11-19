// A release's ID: a UUID of version 7, made with `uuidV7` from `@repo/utils`, whose first 48 bits
// are the time it was made, in milliseconds. So IDs sort as text in the order they were made,
// which lets the table list a domain's releases newest first, and lets the worker tell a release
// asked for before the one on `live` by its time. Two IDs made in the same millisecond are in no
// order: the rest of each is random.

const RELEASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isReleaseId(value: string): boolean {
  return RELEASE_ID.test(value);
}

/** When the release was asked for, in milliseconds since the epoch, from its ID. */
export function releaseRequestedAt(id: string): number {
  if (!isReleaseId(id)) throw new TypeError("The value isn't a release's ID");
  return Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
}
