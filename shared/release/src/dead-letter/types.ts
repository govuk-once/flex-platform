// The config baked into the dead-letter worker, once per stage.
export interface DeadLetterConfig {
  /** The region the release table is in, which the worker runs in too. */
  readonly region: string;
  /** The release table, by name. */
  readonly table: string;
}
