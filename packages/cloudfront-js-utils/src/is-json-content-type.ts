// Whether a Content-Type header's value says JSON, with or without parameters.
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

export function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && JSON_CONTENT_TYPE.test(value);
}
