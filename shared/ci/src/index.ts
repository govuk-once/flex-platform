// What runs in the function, for the infrastructure that deploys it. The build is `./build`.
export { UPLOAD_EXPIRES_SECONDS } from "./function/sign-upload.ts";
export type { CiDomain, CiEnvironment } from "./function/types.ts";
