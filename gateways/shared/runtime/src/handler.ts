import type {
  DriverDefinition,
  GatewayConfig,
  OperationConfig,
} from "@repo/gateway-config";
import type {
  EnvelopeResponse,
  ExecuteFn,
  SignalRuling,
  Validator,
} from "@repo/gateway-types";
import { ERROR_CODES } from "@repo/gateway-types";

import { createDriverContext, type DeadlineProvider } from "./context.ts";
import { parseEnvelope } from "./envelope.ts";
import { describeUnexpectedError, GatewayError } from "./errors.ts";
import { type CompiledPath, compilePaths } from "./field-path.ts";
import { createLogger, pickFields } from "./logging.ts";
import { resolvePolicy } from "./policy.ts";
import type { CompiledBinding } from "./secure.ts";
import { checkSecureBindings, compileBindings } from "./secure.ts";

export interface OperationValidators {
  readonly input: Validator;
  readonly outcomes: Readonly<Record<string, Validator>>;
}

export type AnyOperations = Readonly<Record<string, OperationConfig>>;

// Keyed by the configuration's operations, so a missing or misnamed validator set fails to
// typecheck. What varies per invocation, the deadline, is passed to the handler instead.
export interface HandlerDeps<TOps extends AnyOperations = AnyOperations> {
  readonly validators: { readonly [K in keyof TOps]: OperationValidators };
  readonly execute: ExecuteFn;
}

export interface Invocation {
  readonly deadline: DeadlineProvider;
}

export type GatewayHandler = (
  event: unknown,
  invocation: Invocation,
) => Promise<EnvelopeResponse>;

export type DispatchStep =
  | "envelope"
  | "token"
  | "routing"
  | "input"
  | "bindings"
  | "deadline"
  | "execute"
  | "outcome"
  | "response";

export type AnyGatewayConfig = GatewayConfig<DriverDefinition, AnyOperations>;

interface CompiledOperation {
  readonly config: OperationConfig;
  readonly input: Validator;
  // A Map, not an object: the outcome name comes from the driver at request time, and an
  // object lookup would find inherited members such as "constructor" and treat them as a
  // validator.
  readonly outcomes: ReadonlyMap<string, Validator>;
  readonly logInput: readonly CompiledPath[];
  readonly logOutput: readonly CompiledPath[];
  readonly secureBindings: readonly CompiledBinding[];
}

function compileOperations(
  config: AnyGatewayConfig,
  validators: Readonly<Record<string, OperationValidators | undefined>>,
): ReadonlyMap<string, CompiledOperation> {
  const opNames = Object.keys(config.operations);
  if (opNames.length === 0) {
    throw new Error("Gateway config must define at least one operation");
  }

  const ops = new Map<string, CompiledOperation>();

  for (const opName of opNames) {
    const opConfig = config.operations[opName];
    if (!opConfig) {
      throw new Error(`Operation "${opName}" missing from config`);
    }
    const opValidators = validators[opName];
    if (!opValidators) {
      throw new Error(`Missing validators for operation "${opName}"`);
    }
    if (typeof opValidators.input !== "function") {
      throw new Error(`Missing input validator for operation "${opName}"`);
    }

    const outcomes = new Map<string, Validator>();
    for (const [outcome, validator] of Object.entries(opValidators.outcomes)) {
      if (typeof validator !== "function") {
        throw new Error(
          `Outcome "${outcome}" of operation "${opName}" has no validator function`,
        );
      }
      outcomes.set(outcome, validator);
    }
    if (outcomes.size === 0) {
      throw new Error(
        `Operation "${opName}" must have at least one outcome validator`,
      );
    }

    ops.set(opName, {
      config: opConfig,
      input: opValidators.input,
      outcomes,
      logInput: compilePaths(opConfig.log?.input ?? []),
      logOutput: compilePaths(opConfig.log?.output ?? []),
      secureBindings: compileBindings(opConfig.secure),
    });
  }

  return ops;
}

function verifyToken(): void {
  // No token verification is performed. This hook does not authenticate the caller.
}

function formatValidationErrors(
  errors:
    | Array<{ instancePath: string; schemaPath: string; message?: string }>
    | null
    | undefined,
): string {
  if (!errors || errors.length === 0) return "Input validation failed";
  return errors
    .map((e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`)
    .join("; ");
}

function extractOperation(event: unknown): string | undefined {
  if (event != null && typeof event === "object" && "operation" in event) {
    const operation = (event as Record<string, unknown>).operation;
    return typeof operation === "string" ? operation : undefined;
  }
  return undefined;
}

// Reserve time after the upstream call for outcome validation, logging and the response envelope.
const DEADLINE_SAFETY_MARGIN_MS = 500;

function recordHealthSignal(
  _operation: string | undefined,
  signal: SignalRuling,
): { signal: SignalRuling } {
  // Returns a classification for logging; no health state is updated.
  return { signal };
}

// Compiles once; the returned handler serves every invocation, each with its own deadline.
export function createHandler<const TOps extends AnyOperations>(
  config: GatewayConfig<DriverDefinition, TOps>,
  deps: HandlerDeps<TOps>,
): GatewayHandler {
  if (!config.id || typeof config.id !== "string") {
    throw new Error("Gateway config must have a non-empty string id");
  }

  const operations = compileOperations(config, deps.validators);
  const logger = createLogger(config.id);

  const policy = resolvePolicy(config.policy);

  return async (event, invocation): Promise<EnvelopeResponse> => {
    // The runtime's own record of how far a request got, logged beside the source locations
    // of an undeclared error so the step and the site locate it together.
    let step: DispatchStep = "envelope";
    try {
      // Step 1: Parse envelope
      const envelope = parseEnvelope(event);

      // Step 2: Verify token (STUB)
      step = "token";
      verifyToken();

      // Step 3: Route on operation
      step = "routing";
      const op = operations.get(envelope.operation);
      if (!op) {
        throw new GatewayError(
          "OPERATION_NOT_FOUND",
          `Unknown operation: ${envelope.operation}`,
        );
      }

      // Step 4: Validate input
      step = "input";
      if (!op.input(envelope.input)) {
        throw new GatewayError(
          "INVALID_INPUT",
          formatValidationErrors(op.input.errors),
        );
      }

      // Step 5: Check secure bindings
      step = "bindings";
      checkSecureBindings(
        op.secureBindings,
        envelope.input,
        envelope.secure.values,
        envelope.secure.signature,
      );

      // Step 6: Derive deadline
      step = "deadline";
      const { deadline } = invocation;
      const requestDeadline: DeadlineProvider = {
        remainingMs(): number {
          return Math.max(
            0,
            deadline.remainingMs() - DEADLINE_SAFETY_MARGIN_MS,
          );
        },
      };

      // Step 7: Run pipeline
      step = "execute";
      const ctx = createDriverContext(policy, requestDeadline);
      const result = await deps.execute(
        ctx,
        envelope.operation,
        envelope.input,
      );

      // Step 8: Validate outcome
      step = "outcome";
      const outcomeValidator = op.outcomes.get(result.outcome);
      if (outcomeValidator === undefined) {
        throw new GatewayError(
          "UPSTREAM_CONTRACT_VIOLATION",
          `Unknown outcome "${result.outcome}" for operation "${envelope.operation}"`,
        );
      }
      if (!outcomeValidator(result.data)) {
        throw new GatewayError(
          "UPSTREAM_CONTRACT_VIOLATION",
          `Outcome "${result.outcome}" data failed validation for operation "${envelope.operation}"`,
        );
      }

      // Step 9: Record health (success path)
      step = "response";
      const health = recordHealthSignal(envelope.operation, "upstream_success");

      // Step 10: Wrap envelope
      logger.info(
        {
          operation: envelope.operation,
          outcome: result.outcome,
          ...health,
          input: pickFields(envelope.input, op.logInput),
          output: pickFields(result.data, op.logOutput),
        },
        "response",
      );

      return {
        ok: true as const,
        outcome: result.outcome,
        data: result.data,
      };
    } catch (err: unknown) {
      if (err instanceof GatewayError) {
        // Step 9: Record health (error path)
        const health = recordHealthSignal(
          extractOperation(event),
          ERROR_CODES[err.code].signal,
        );

        logger.warn(
          { operation: extractOperation(event), code: err.code, ...health },
          err.message,
        );
        // Detail is logged above, never returned.
        return { ok: false as const, error: { code: err.code } };
      }

      // Step 9: Record health (unhandled)
      const health = recordHealthSignal(
        extractOperation(event),
        ERROR_CODES.INTERNAL.signal,
      );

      // Nothing declared this error, so nothing about it is known to be safe to log. The
      // envelope is returned whatever happens here; logging must not become a second failure.
      try {
        logger.error(
          { err: describeUnexpectedError(err), step, ...health },
          "Unhandled error in dispatcher",
        );
      } catch {
        // The response still carries the code.
      }
      return { ok: false as const, error: { code: "INTERNAL" as const } };
    }
  };
}
