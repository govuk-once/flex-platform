const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;

export function isCamelCase(name: string): boolean {
  return CAMEL_CASE.test(name);
}
