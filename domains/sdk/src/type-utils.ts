// Nothing here knows about domains, so each type can move to a shared package unchanged.

// A required property named for the mistake. The compiler reports it missing, so the message
// reads as the rule that was broken, on the line that broke it.
export type Problem<Message extends string> = {
  readonly [Text in Message]: never;
};

export type IsNever<Type> = [Type] extends [never] ? true : false;

export type IsSame<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

export type HasField<Type, Field extends string> = Field extends keyof Type
  ? true
  : false;

// "id" and "linkId" from "/v1/todos/{id}/links/{linkId}".
export type PathParameters<Template extends string> =
  Template extends `${string}{${infer Param}}${infer Rest}`
    ? Param | PathParameters<Rest>
    : never;
