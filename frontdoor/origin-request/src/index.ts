// What runs in the function, for the infrastructure that deploys it. The build is `./build`.
export {
  CALLER_TOKEN_HEADER,
  HEADERS_SET_BY_FUNCTION,
} from "./function/forward.ts";
export { SIGNING_REGION } from "./function/sign.ts";
export type { OriginRequestConfig } from "./function/types.ts";
