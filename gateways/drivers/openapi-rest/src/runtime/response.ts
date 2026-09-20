import { GatewayError } from "@repo/gateway-runtime";
import type { ErrorCode } from "@repo/gateway-types";

// Codes for statuses with a specific meaning. Other 4xx are UPSTREAM_REJECTED and 5xx are
// UPSTREAM_ERROR. 401 and 403 mean the gateway's own credentials were refused, which the
// upstream answered normally, so they are rejections rather than failures. 429 is RATE_LIMITED
// whichever side imposed the limit; its health ruling stays neutral by design.
const ERROR_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  401: "UPSTREAM_REJECTED",
  403: "UPSTREAM_REJECTED",
  404: "NOT_FOUND",
  429: "RATE_LIMITED",
};

// Messages name the operation, its template and the status: enough to diagnose, never the
// resolved path or body, which can contain input values.
export function errorForStatus(
  status: number,
  operation: string,
  template: string,
): GatewayError {
  const where = `for operation "${operation}" (${template})`;
  const mapped = ERROR_BY_STATUS[status];
  if (mapped !== undefined) {
    return new GatewayError(mapped, `Upstream returned ${status} ${where}`);
  }
  if (status >= 500) {
    return new GatewayError(
      "UPSTREAM_ERROR",
      `Upstream returned ${status} ${where}`,
    );
  }
  if (status >= 400) {
    return new GatewayError(
      "UPSTREAM_REJECTED",
      `Upstream returned ${status} ${where}`,
    );
  }
  return new GatewayError(
    "UPSTREAM_CONTRACT_VIOLATION",
    `Upstream returned unexpected status ${status} ${where}`,
  );
}

// `where` names the request as its diagnostics do, such as `for operation "x" (GET /x)`.
export function parseJsonBody(text: string, where: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError(
      "UPSTREAM_CONTRACT_VIOLATION",
      `Upstream response body is not JSON ${where}`,
    );
  }
}
