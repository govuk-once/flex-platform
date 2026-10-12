import {
  buildViewerRequestFunction,
  type TrustedIssuer,
} from "@repo/frontdoor-cloudfront-function";
import {
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionRuntime,
} from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";

export interface ViewerRequestFunctionProps {
  /** The user pools and app clients whose tokens the function lets through. */
  readonly issuers: readonly TrustedIssuer[];
}

/** The CloudFront Function that checks each request's structure, built with an environment's issuers. */
export class ViewerRequestFunction extends Construct {
  public readonly function: CloudFrontFunction;

  constructor(scope: Construct, id: string, props: ViewerRequestFunctionProps) {
    super(scope, id);

    this.function = new CloudFrontFunction(this, "Function", {
      code: FunctionCode.fromInline(
        buildViewerRequestFunction({ issuers: props.issuers }),
      ),
      runtime: FunctionRuntime.JS_2_0,
    });
  }
}
