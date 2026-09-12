export interface Validator<T = unknown> {
  (data: unknown): data is T;
  errors?:
    | Array<{ instancePath: string; schemaPath: string; message?: string }>
    | null
    | undefined;
}
