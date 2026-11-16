// Baked into the function when it is built, once per stage.
export interface ViewerRequestConfig {
  /** Who issues a pipeline's token, as its `iss` claim has it. */
  readonly issuer: string;
  /** Who a pipeline's token must be for, as its `aud` claim has it: this stage's pipeline API. */
  readonly audience: string;
}
