/**
 * The header a pipeline sends its token in, as the token alone, with no scheme. Not
 * `Authorization`, which CloudFront replaces with its own signature for the origin. The function
 * reads it, and the pipeline API's function and the distribution name it. The build is `./build`.
 */
export const CI_TOKEN_HEADER = "x-flex-ci-token";
