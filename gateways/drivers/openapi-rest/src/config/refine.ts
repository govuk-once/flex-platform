import type { ParameterMapping } from "./definition.ts";

// "{a}" and "{b}" from "/x/{a}/y/{b}". A non-literal string yields never, leaving the check to
// compileOperation at executor creation.
export type PathParameters<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}`
    ? P | PathParameters<Rest>
    : never;

type Template<TOp> = TOp extends { readonly upstream: infer U extends string }
  ? U
  : string;

type Parameters<TOp> = TOp extends { readonly parameters: infer P }
  ? P
  : Record<never, never>;

// The upstream names the operation's `in: "path"` entries claim: the entry's `name`, or its key
// when no name is given.
type DeclaredPathParameters<TParams> = {
  [K in keyof TParams]: TParams[K] extends { readonly in: "path" }
    ? TParams[K] extends { readonly name: infer N extends string }
      ? N
      : K & string
    : never;
}[keyof TParams];

// What an existing entry must look like once the template is known. A path entry may only name
// a template parameter, through `name` or, without one, through its key. Other entries pass.
type ConstrainedEntry<
  TParamsOfTemplate extends string,
  K,
  Entry,
> = Entry extends { readonly in: "path" }
  ? Entry extends { readonly name: string }
    ? { readonly in: "path"; readonly name: TParamsOfTemplate }
    : K extends TParamsOfTemplate
      ? Entry
      : { readonly in: "path"; readonly name: TParamsOfTemplate }
  : Entry;

// Whether the template is a single literal, so its parameters can be read statically. A
// helper that takes `upstream: UpstreamTemplate` passes a pattern type instead; only
// compileOperation can check that one, at executor creation. An empty object type extends a
// record keyed by a pattern or by `string`, whose keys are all optional, but not one keyed by a
// literal, whose key is required.
type TemplateKnown<TOp> =
  Record<never, never> extends Record<Template<TOp>, never> ? false : true;

type Missing<TOp> =
  TemplateKnown<TOp> extends true
    ? Exclude<
        PathParameters<Template<TOp>>,
        DeclaredPathParameters<Parameters<TOp>>
      >
    : never;

type Extra<TOp> =
  TemplateKnown<TOp> extends true
    ? Exclude<
        DeclaredPathParameters<Parameters<TOp>>,
        PathParameters<Template<TOp>>
      >
    : never;

// The existing entries as the corrected shape requires them. With an unknown template a path
// entry cannot be checked against it, so entries pass through unchanged.
type CorrectedEntries<TOp> =
  TemplateKnown<TOp> extends true
    ? {
        readonly [K in keyof Parameters<TOp>]: ConstrainedEntry<
          PathParameters<Template<TOp>>,
          K,
          Parameters<TOp>[K]
        >;
      }
    : { readonly [K in keyof Parameters<TOp>]: Parameters<TOp>[K] };

// Keys written on a parameter mapping that ParameterMapping does not have, such as `nmae`.
type UnknownMappingKeys<TParams> = {
  [F in keyof TParams]: Exclude<keyof TParams[F], keyof ParameterMapping>;
}[keyof TParams];

type ExactMappingKeys<TParams> = {
  readonly [F in keyof TParams]: {
    readonly [K in Exclude<keyof TParams[F], keyof ParameterMapping>]: never;
  };
};

// Every "{param}" in the template must have an entry with in: "path" that names it, no path
// entry may name a parameter the template lacks, and a mapping may carry no key that
// ParameterMapping lacks. When any of these fails, the operation must also satisfy the corrected
// `parameters` shape, which is what the type error then reports: a missing entry keyed by the
// parameter, an entry whose `name` must be one of the template's, or a misspelled key that
// must be `never`. When the template is not a literal, only the mapping-key check applies and
// the rest waits for executor creation.
export type RefineOpenApiRestOperation<TOp> = [
  Missing<TOp> | Extra<TOp> | UnknownMappingKeys<Parameters<TOp>>,
] extends [never]
  ? TOp
  : TOp & {
      readonly parameters: {
        readonly [P in Missing<TOp>]: {
          readonly in: "path";
          readonly name?: P;
        };
      } & CorrectedEntries<TOp> &
        ExactMappingKeys<Parameters<TOp>>;
    };

declare module "@repo/gateway-config" {
  interface OperationRefinements<TOp> {
    readonly "openapi-rest": RefineOpenApiRestOperation<TOp>;
  }
}
