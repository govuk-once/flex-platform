// What a CloudFront Function's code uses. A function bundles what it imports from here, so all of
// it runs in the cloudfront-js-2.0 runtime. The build is a separate entry, which runs in Node.
export type {
  CloudFrontRequest,
  CloudFrontResponse,
  FieldValue,
  ViewerRequestEvent,
} from "./event.ts";
export { isJsonRequest } from "./json-request.ts";
export { removePlatformHeaders } from "./platform-headers.ts";
export { isRepeated } from "./repeated.ts";
export {
  badRequest,
  methodNotAllowed,
  notFound,
  unauthorized,
  unsupportedMediaType,
} from "./responses.ts";
export type { RequestIds } from "./telemetry.ts";
export { logOutcome } from "./telemetry.ts";
