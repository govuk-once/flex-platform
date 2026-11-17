/**
 * The header a pipeline sends its token in, as the token alone, with no scheme. Not
 * `Authorization`, which CloudFront replaces with its own signature for the origin. In a module of
 * its own, so the pipeline API's function can name the header without the build of this one.
 */
export const CI_TOKEN_HEADER = "x-flex-ci-token";
