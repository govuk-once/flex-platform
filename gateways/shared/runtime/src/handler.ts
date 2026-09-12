import type {
  DriverDefinition,
  GatewayConfig,
  OperationConfig,
} from "@repo/gateway-config";
import type {
  EnvelopeResponse,
  SignalRuling,
  Validator,
} from "@repo/gateway-types";
import { ERROR_CODES } from "@repo/gateway-types";

import {
  createDriverContext,
  type DeadlineProvider,
  type DriverContext,
} from "./context.ts";
import { parseEnvelope } from "./envelope.ts";
import { GatewayError } from "./errors.ts";
import { type CompiledPath, compilePaths } from "./field-path.ts";
import { createLogger, pickFields } from "./logging.ts";
import { resolvePolicy } from "./policy.ts";
import type { CompiledBinding } from "./secure.ts";
import { checkSecureBindings, compileBindings } from "./secure.ts";

export interface HandlerDeps {
  readonly validators: Readonly<
    Record<
      string,
      {
        readonly input: Validator;
        readonly outcomes: Readonly<Record<string, Validator>>;
      }
    >
  >;
  readonly execute: (
    ctx: DriverContext,
    operation: string,
    input: unknown,
  ) => Promise<{ outcome: string; data: unknown }>;
  readonly deadline: DeadlineProvider;
}

export type AnyGatewayConfig = GatewayConfig<
  DriverDefinition,
  Readonly<Record<string, OperationConfig>>
>;

interface CompiledOperation {
  readonly config: OperationConfig;
  readonly validators: {
    readonly input: Validator;
    readonly outcomes: Readonly<Record<string, Validator>>;
  };
  readonly logInput: readonly CompiledPath[];
  readonly logOutput: readonly CompiledPath[];
  readonly secureBindings: readonly CompiledBinding[];
}

function compileOperations(
  config: AnyGatewayConfig,
  deps: HandlerDeps,
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
    const opValidators = deps.validators[opName];
    if (!opValidators) {
      throw new Error(`Missing validators for operation "${opName}"`);
    }
    if (typeof opValidators.input !== "function") {
      throw new Error(`Missing input validator for operation "${opName}"`);
    }
    if (Object.keys(opValidators.outcomes).length === 0) {
      throw new Error(
        `Operation "${opName}" must have at least one outcome validator`,
      );
    }

    ops.set(opName, {
      config: opConfig,
      validators: opValidators,
      logInput: compilePaths(opConfig.log?.input ?? []),
      logOutput: compilePaths(opConfig.log?.output ?? []),
      secureBindings: compileBindings(opConfig.secure),
    });
  }

  return ops;
}

function verifyToken(): void {
  // STUB: JWT verification will land here.
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

const DEADLINE_SAFETY_MARGIN_MS = 500;

function recordHealthSignal(
  _operation: string | undefined,
  signal: SignalRuling,
): { signal: SignalRuling } {
  // STUB: breaker/health recording will land here.
  return { signal };
}

export function createHandler(
  config: AnyGatewayConfig,
  deps: HandlerDeps,
): (event: unknown) => Promise<EnvelopeResponse> {
  if (!config.id || typeof config.id !== "string") {
    throw new Error("Gateway config must have a non-empty string id");
  }

  const operations = compileOperations(config, deps);
  const logger = createLogger(config.id);

  const policy = resolvePolicy(config.policy);
  const { deadline } = deps;

  return async (event: unknown): Promise<EnvelopeResponse> => {
    try {
      // Step 1: Parse envelope
      const envelope = parseEnvelope(event);

      // Step 2: Verify token (STUB)
      verifyToken();

      // Step 3: Route on operation
      const op = operations.get(envelope.operation);
      if (!op) {
        throw new GatewayError(
          "OPERATION_NOT_FOUND",
          `Unknown operation: ${envelope.operation}`,
        );
      }

      // Step 4: Validate input
      if (!op.validators.input(envelope.input)) {
        throw new GatewayError(
          "INVALID_INPUT",
          formatValidationErrors(op.validators.input.errors),
        );
      }

      // Step 5: Check secure bindings
      checkSecureBindings(
        op.secureBindings,
        envelope.input,
        envelope.secure.values,
        envelope.secure.signature,
      );

      // Step 6: Derive deadline
      const requestDeadline: DeadlineProvider = {
        remainingMs(): number {
          return Math.max(
            0,
            deadline.remainingMs() - DEADLINE_SAFETY_MARGIN_MS,
          );
        },
      };

      // Step 7: Run pipeline
      const ctx = createDriverContext(policy, requestDeadline);
      const result = await deps.execute(
        ctx,
        envelope.operation,
        envelope.input,
      );

      // Step 8: Validate outcome
      const outcomeValidator = op.validators.outcomes[result.outcome];
      if (!outcomeValidator) {
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
      const health = recordHealthSignal(envelope.operation, "upstream_success");

      // Step 10: Wrap envelope
      const inputFields = pickFields(envelope.input, op.logInput);
      const outputFields = pickFields(result.data, op.logOutput);
      logger.info(
        {
          operation: envelope.operation,
          outcome: result.outcome,
          ...health,
          ...(inputFields ? { input: inputFields } : {}),
          ...(outputFields ? { output: outputFields } : {}),
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

      logger.error({ err, ...health }, "Unhandled error in dispatcher");
      return { ok: false as const, error: { code: "INTERNAL" as const } };
    }
  };
}
