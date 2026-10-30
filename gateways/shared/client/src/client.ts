// Calls a gateway's Lambda function directly, typed by the gateway's generated call contract.
// The caller gets back what the gateway answered, an error envelope included. Anything that
// stops it answering is a GatewayInvocationError instead.

import {
  InvokeCommand,
  LambdaClient,
  type LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import {
  type EnvelopeResponse,
  GATEWAY_FUNCTION_ALIAS,
  gatewayFunctionName,
} from "@repo/gateway-core";

import { currentCallerContext, type SecureContext } from "./context.ts";
import { parseResponse } from "./response.ts";

/** What a generated contract's `Operations` holds for each operation. */
export interface ContractOperation {
  readonly input: unknown;
  readonly response: unknown;
}

export type ContractOperations<TOperations> = {
  readonly [TName in keyof TOperations]: ContractOperation;
};

export type OperationName<TOperations> = keyof TOperations & string;

export interface CallOptions {
  /** Stops waiting for the gateway. The call may still complete, and is not sent again. */
  readonly signal?: AbortSignal;
}

/**
 * A function per operation, named for it, taking its input. Mapped over the contract's own keys,
 * so each function carries the description the contract gives its operation.
 */
export type GatewayClient<TOperations extends ContractOperations<TOperations>> =
  {
    readonly [TName in keyof TOperations]: (
      input: TOperations[TName]["input"],
      options?: CallOptions,
    ) => Promise<TOperations[TName]["response"]>;
  };

export type InvocationFailure =
  /** The call ended before Lambda answered: refused, throttled or unreachable. */
  | "invoke_failed"
  /** The function failed rather than answering, as it does when it times out. */
  | "function_error"
  /** The function answered with something that is not a response envelope. */
  | "invalid_response"
  /** The caller's signal stopped the wait. */
  | "aborted"
  /** The caller's deadline passed: the call was abandoned, or not sent. */
  | "timed_out";

/** A call the gateway did not answer. Its message is fixed text, safe to log. */
export class GatewayInvocationError extends Error {
  override readonly name = "GatewayInvocationError";

  constructor(
    readonly reason: InvocationFailure,
    message: string,
  ) {
    super(message);
  }
}

const NO_SECURE_VALUES: SecureContext = { values: {}, signature: "" };

/** The Lambda client's settings, which only this package's tests give. Retries are always off. */
export type LambdaSettings = Omit<
  LambdaClientConfig,
  "maxAttempts" | "retryMode" | "retryStrategy"
>;

// The gateway's function is named from the environment and its id, and invoked through its one
// alias, in the caller's own account and region. The Lambda client takes everything else from
// the environment it runs in, as a domain's function provides it.
export function connect<TOperations extends ContractOperations<TOperations>>(
  environment: string,
  gatewayId: string,
  /** The contract's operations, which codegen lists, since types are gone at runtime. */
  operations: readonly OperationName<TOperations>[],
  settings: LambdaSettings = {},
): GatewayClient<TOperations> {
  const functionName = `${gatewayFunctionName(environment, gatewayId)}:${GATEWAY_FUNCTION_ALIAS}`;
  // One attempt only. A retried invoke can repeat an upstream write, and whether a retry is safe
  // depends on the operation and the deadline, which the SDK knows nothing of.
  const lambda = new LambdaClient({ ...settings, maxAttempts: 1 });

  // Every operation's function calls this. A domain sees only the functions.
  async function call(
    operation: string,
    input: unknown,
    callOptions: CallOptions = {},
  ): Promise<EnvelopeResponse> {
    const caller = currentCallerContext();
    let deadline: AbortSignal | undefined;
    if (caller !== undefined) {
      const remaining = caller.deadline - Date.now();
      if (remaining <= 0) {
        throw new GatewayInvocationError(
          "timed_out",
          "The caller's deadline had passed, so the gateway was not invoked",
        );
      }
      deadline = AbortSignal.timeout(remaining);
    }
    const signals = [callOptions.signal, deadline].filter(
      (signal) => signal !== undefined,
    );
    const command = new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(
        JSON.stringify({
          operation,
          input,
          secure: caller?.secure ?? NO_SECURE_VALUES,
        }),
      ),
    });

    let output;
    try {
      output = await lambda.send(
        command,
        signals.length > 0 ? { abortSignal: AbortSignal.any(signals) } : {},
      );
    } catch (error) {
      throw invokeError(error, callOptions.signal, deadline);
    }

    if (output.FunctionError !== undefined) {
      throw new GatewayInvocationError(
        "function_error",
        `The gateway's function failed: ${output.FunctionError}`,
      );
    }
    const response =
      output.StatusCode === 200 && output.Payload
        ? parseResponse(output.Payload)
        : undefined;
    if (response === undefined) {
      throw new GatewayInvocationError(
        "invalid_response",
        "The gateway's answer is not a response envelope",
      );
    }
    // The envelope's shape is checked, not its outcome: the gateway checked that against its
    // schemas before answering.
    return response;
  }

  // Own properties of a plain object, so a stub can replace one.
  return Object.fromEntries(
    operations.map((operation) => [
      operation,
      (input: unknown, callOptions?: CallOptions) =>
        call(operation, input, callOptions),
    ]),
  ) as GatewayClient<TOperations>;
}

// The SDK's message can carry the service's own text, so only the error's name is kept, which
// for a Lambda refusal is its exception type.
function invokeError(
  error: unknown,
  signal: AbortSignal | undefined,
  deadline: AbortSignal | undefined,
): GatewayInvocationError {
  if (signal?.aborted) {
    return new GatewayInvocationError(
      "aborted",
      "The call was abandoned before the gateway answered",
    );
  }
  if (deadline?.aborted) {
    return new GatewayInvocationError(
      "timed_out",
      "The caller's deadline passed before the gateway answered",
    );
  }
  const name = error instanceof Error ? error.name : "a non-error value";
  return new GatewayInvocationError(
    "invoke_failed",
    `The gateway could not be invoked: ${name}`,
  );
}
