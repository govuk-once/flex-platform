import type { core } from "zod";

export type JsonSchema = core.JSONSchema.JSONSchema;

export type SchemaUse = "input" | "output";

export type Content = Readonly<Record<string, { readonly schema: JsonSchema }>>;

export interface OpenApiResponse {
  readonly description: string;
  readonly content?: Content;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: "path" | "query";
  readonly required: boolean;
  readonly schema: JsonSchema;
}

export interface OpenApiOperation {
  readonly operationId?: string;
  readonly description?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required: true;
    readonly content: Content;
  };
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly paths: Readonly<
    Record<string, Readonly<Record<string, OpenApiOperation>>>
  >;
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchema>>;
  };
}

export interface OpenApiOptions {
  readonly version: string;
  readonly title?: string;
}
