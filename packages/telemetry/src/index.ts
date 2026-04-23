export {
  createLogger,
  otelContextMixin,
  REDACT_PATHS,
  type CreateLoggerInput,
  type Logger,
} from "./logger.js";

export { createTracer, trace, type Span, type SpanOptions, type Tracer } from "./tracer.js";

export {
  parseOtlpHeadersEnv,
  registerOtelSdk,
  registerOtelSdkFromEnv,
  type OtelSdkHandle,
  type RegisterOtelSdkInput,
} from "./otel-sdk.js";
