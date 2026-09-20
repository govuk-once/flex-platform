import type {
  DriverDefinition,
  GatewayConfig,
  OperationConfig,
} from "@repo/gateway-config";
import type {
  EnvelopeMeta,
  EnvelopeResponse,
  ExecuteFn,
  MetaValue,
  SignalRuling,
  Validator,
} from "@repo/gateway-types";
import { ERROR_CODES } from "@repo/gateway-types";
import { isScalar } from "@repo/utils/is-scalar";

import {
  createDriverContext,
  type DeadlineProvider,
  type ReportedMeta,
} from "./context.ts";
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
  // A validator for each thing the gateway may report about an exchange beside its result, by
  // the name it is reported under. Left out by a gateway that reports nothing.
  readonly meta?: Readonly<Record<string, Validator>>;
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

// A Map for the reason the outcomes are one: the name comes from a driver at request time.
function compileMeta(
  validators: Readonly<Record<string, Validator>> | undefined,
): ReadonlyMap<string, Validator> {
  const compiled = new Map<string, Validator>();
  for (const [name, validator] of Object.entries(validators ?? {})) {
    if (typeof validator !== "function") {
      throw new Error(`Metadata "${name}" has no validator function`);
    }
    compiled.set(name, validator);
  }
  return compiled;
}

// What of a driver's report a caller and a log may see: what the gateway declared, where it is
// the scalar its schema says. The rest is left out and nothing is said of its value, only of
// where its schema refused it. A report is never a reason to fail a call: what it describes has
// already happened, and one that went wrong is worth less than the answer it rode in with.
function acceptedMeta(
  declared: ReadonlyMap<string, Validator>,
  reported: ReportedMeta,
  refused: (name: string, where: string) => void,
): EnvelopeMeta | undefined {
  const accepted: Record<string, MetaValue> = {};
  for (const [name, validator] of declared) {
    if (!reported.has(name)) continue;
    const value = reported.get(name);
    try {
      if (!isScalar(value)) {
        refused(name, "not a string, a finite number or a boolean");
      } else if (validator(value)) {
        accepted[name] = value;
      } else {
        refused(name, formatValidationErrors(validator.errors));
      }
    } catch {
      refused(name, "its validator failed");
    }
  }
  return Object.keys(accepted).length > 0 ? accepted : undefined;
}

function verifyToken(): void {
  // No token verification is performed. This hook does not authenticate the caller.
}

// Where validation failed, as schema locations. Never the instance path: its segments come from
// the data, so under a dictionary schema they are the caller's own keys, and this message is
// logged. Payload fields reach a log only through `log.input`. The keywords' own messages are
// written from the schema, never from the value, so they stay.
function formatValidationErrors(
  errors:
    | Array<{ instancePath: string; schemaPath: string; message?: string }>
    | null
    | undefined,
): string {
  if (!errors || errors.length === 0) return "Input validation failed";
  return errors
    .map((e) => `${e.schemaPath || "#"}: ${e.message ?? "invalid"}`)
    .join("; ");
}

// The operation name a failure is logged under, taken from the event rather than the envelope so
// that a request rejected before parsing has one too. It is the caller's string, so it is logged
// only once it has been matched against the configured operations: a recognised name is the
// gateway's own vocabulary and says which contract failed, where an unrecognised one is whatever
// the caller sent, of any length and content, and the envelope that carried it may be malformed
// in every other respect. A Map, so a name such as "constructor" is not found on a prototype.
function loggedOperation(
  event: unknown,
  operations: ReadonlyMap<string, CompiledOperation>,
): string | undefined {
  if (event == null || typeof event !== "object" || !("operation" in event)) {
    return undefined;
  }
  const { operation } = event as Record<string, unknown>;
  return typeof operation === "string" && operations.has(operation)
    ? operation
    : undefined;
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
  const declaredMeta = compileMeta(deps.meta);
  const logger = createLogger(config.id);

  const policy = resolvePolicy(config.policy);

  return async (event, invocation): Promise<EnvelopeResponse> => {
    // The runtime's own record of how far a request got, logged beside the source locations
    // of an undeclared error so the step and the site locate it together.
    let step: DispatchStep = "envelope";
    // Outside the attempt, so what a driver reported before it failed is still to hand.
    const reported: ReportedMeta = new Map();
    const metaOf = (): { meta?: EnvelopeMeta } => {
      const meta = acceptedMeta(declaredMeta, reported, (name, where) => {
        logger.warn(
          { operation: loggedOperation(event, operations), metadata: name },
          `Reported metadata left out: ${where}`,
        );
      });
      return meta === undefined ? {} : { meta };
    };
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
        // The name is the caller's and was not one of ours, so it is not repeated here: the
        // code says what happened, and the log leaves the operation out.
        throw new GatewayError("OPERATION_NOT_FOUND", "Unknown operation");
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
      const ctx = createDriverContext(policy, requestDeadline, reported);
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
      const meta = metaOf();
      logger.info(
        {
          operation: envelope.operation,
          outcome: result.outcome,
          ...health,
          input: pickFields(envelope.input, op.logInput),
          output: pickFields(result.data, op.logOutput),
          ...meta,
        },
        "response",
      );

      return {
        ok: true as const,
        outcome: result.outcome,
        data: result.data,
        ...meta,
      };
    } catch (err: unknown) {
      const operation = loggedOperation(event, operations);

      if (err instanceof GatewayError) {
        // Step 9: Record health (error path)
        const health = recordHealthSignal(
          operation,
          ERROR_CODES[err.code].signal,
        );

        const meta = metaOf();
        logger.warn(
          { operation, code: err.code, ...health, ...meta },
          err.message,
        );
        // Detail is logged above, never returned. What the gateway declared it may report is
        // not detail: it is validated, and a failure is when a caller most needs it.
        return { ok: false as const, error: { code: err.code }, ...meta };
      }

      // Step 9: Record health (unhandled)
      const health = recordHealthSignal(operation, ERROR_CODES.INTERNAL.signal);

      // Nothing declared this error, so nothing about it is known to be safe to log. The
      // envelope is returned whatever happens here; logging must not become a second failure,
      // and neither must what was reported.
      let meta: { meta?: EnvelopeMeta } = {};
      try {
        meta = metaOf();
        logger.error(
          { err: describeUnexpectedError(err), step, ...health, ...meta },
          "Unhandled error in dispatcher",
        );
      } catch {
        // The response still carries the code.
      }
      return {
        ok: false as const,
        error: { code: "INTERNAL" as const },
        ...meta,
      };
    }
  };
}
