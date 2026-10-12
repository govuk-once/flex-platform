import type { StageOptions } from "aws-cdk-lib/aws-apigateway";
import {
  AccessLogField,
  AccessLogFormat,
  LogGroupLogDestination,
  MethodLoggingLevel,
} from "aws-cdk-lib/aws-apigateway";
import type { ILogGroup } from "aws-cdk-lib/aws-logs";

// Written out, not read from the stage: the execution log group is named from it, and the stage
// waits for that group.
export const STAGE_NAME = "prod";

const ACCESS_LOG_FORMAT = AccessLogFormat.custom(
  JSON.stringify({
    requestId: AccessLogField.contextRequestId(),
    xrayTraceId: AccessLogField.contextXrayTraceId(),
    requestTime: AccessLogField.contextRequestTime(),
    ip: AccessLogField.contextIdentitySourceIp(),
    caller: AccessLogField.contextIdentityCaller(),
    user: AccessLogField.contextIdentityUser(),
    httpMethod: AccessLogField.contextHttpMethod(),
    resourcePath: AccessLogField.contextResourcePath(),
    protocol: AccessLogField.contextProtocol(),
    status: AccessLogField.contextStatus(),
    responseLength: AccessLogField.contextResponseLength(),
  }),
);

export function domainStageOptions(accessLogGroup: ILogGroup): StageOptions {
  return {
    stageName: STAGE_NAME,
    tracingEnabled: true,
    metricsEnabled: true,
    loggingLevel: MethodLoggingLevel.ERROR,
    dataTraceEnabled: false,
    accessLogDestination: new LogGroupLogDestination(accessLogGroup),
    accessLogFormat: ACCESS_LOG_FORMAT,
  };
}
