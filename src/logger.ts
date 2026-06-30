import pino from "pino";
import pretty from "pino-pretty";
import type {
  HoopilotLogger,
  HoopilotLoggerOptions,
  LogFields,
  LogFormat,
  LogLevel,
} from "./types";
import { envValue } from "./util";

export const DEFAULT_LOG_FORMAT: LogFormat = "pretty";
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

const LOG_FORMATS = ["json", "pretty"] as const;
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
const PRETTY_INLINE_FIELDS = [
  "component",
  "command",
  "event",
  "method",
  "path",
  "status",
  "durationMs",
  "stream",
  "route",
  "requestId",
  "upstreamPath",
  "upstreamStatus",
  "url",
  "baseUrl",
  "origin",
  "currentVersion",
  "installKind",
  "latestVersion",
  "assetName",
  "count",
  "plan",
  "apiBaseUrl",
  "authStorePath",
] as const;
const PRETTY_IGNORED_FIELDS = ["pid", "hostname", "service", ...PRETTY_INLINE_FIELDS] as const;
const REDACT_PATHS = [
  "apiKey",
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.Authorization",
  "headers.cookie",
  "headers.Cookie",
  "headers.x-api-key",
  "headers.X-Api-Key",
  "token",
  "*.apiKey",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.headers.authorization",
  "*.headers.Authorization",
  "*.headers.cookie",
  "*.headers.Cookie",
  "*.headers.x-api-key",
  "*.headers.X-Api-Key",
];

export const noopLogger: HoopilotLogger = {
  child: () => noopLogger,
  debug: () => {},
  error: () => {},
  fatal: () => {},
  info: () => {},
  trace: () => {},
  warn: () => {},
};

export function createHoopilotLogger(options: HoopilotLoggerOptions = {}): HoopilotLogger {
  const env = options.env ?? process.env;
  const level = parseLogLevel(options.level ?? envValue(env.HOOPILOT_LOG_LEVEL));
  const format = parseLogFormat(options.format ?? envValue(env.HOOPILOT_LOG_FORMAT));
  const pinoOptions: pino.LoggerOptions = {
    base: {
      service: "hoopilot",
      ...options.base,
    },
    level,
    redact: {
      censor: "[Redacted]",
      paths: REDACT_PATHS,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (format === "pretty") {
    return asHoopilotLogger(
      pino(
        pinoOptions,
        pretty({
          // Probe the same sink we write to (stdout / fd 1), so colors are not
          // emitted into a redirected file when only stderr is a TTY. A custom
          // stream's TTY-ness is unknown, so default to no color there.
          colorize: options.colorize ?? (options.stream ? false : process.stdout.isTTY),
          destination: options.stream ?? 1,
          ignore: PRETTY_IGNORED_FIELDS.join(","),
          levelFirst: true,
          messageFormat: formatPrettyMessage,
          singleLine: true,
          translateTime: "SYS:HH:MM:ss",
        }),
      ),
    );
  }

  if (options.stream) {
    return asHoopilotLogger(pino(pinoOptions, options.stream as pino.DestinationStream));
  }
  return asHoopilotLogger(pino(pinoOptions));
}

// Cast pino's Logger to HoopilotLogger through a checked assignment, so a drift
// in either type surfaces as a compile error here instead of being masked by an
// unchecked `as` at each call site.
function asHoopilotLogger(logger: pino.Logger): HoopilotLogger {
  return logger;
}

export function parseLogFormat(value: string | undefined): LogFormat {
  if (!value) {
    return DEFAULT_LOG_FORMAT;
  }
  if (isLogFormat(value)) {
    return value;
  }
  throw new Error(`Invalid log format: ${value}. Expected one of: ${LOG_FORMATS.join(", ")}.`);
}

export function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) {
    return DEFAULT_LOG_LEVEL;
  }
  if (isLogLevel(value)) {
    return value;
  }
  throw new Error(`Invalid log level: ${value}. Expected one of: ${LOG_LEVELS.join(", ")}.`);
}

export function shouldCreateLogger(options: {
  env?: NodeJS.ProcessEnv;
  logFormat?: string;
  logger?: HoopilotLogger;
  logLevel?: string;
}): boolean {
  return Boolean(
    options.logger ||
      options.logFormat ||
      options.logLevel ||
      envValue(options.env?.HOOPILOT_LOG_FORMAT) ||
      envValue(options.env?.HOOPILOT_LOG_LEVEL),
  );
}

/** Build structured log fields describing an error, for the `err` log key. */
export function errorDetails(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function formatPrettyMessage(log: Record<string, unknown>, messageKey: string): string {
  const message = formatPrettyLogMessage(log[messageKey]);
  const fields = PRETTY_INLINE_FIELDS.flatMap((field) => {
    const value = log[field];
    if (value === undefined) {
      return [];
    }
    return `${prettyFieldLabel(field)}=${formatPrettyFieldValue(field, value)}`;
  });
  return fields.length > 0 ? `${message} ${fields.join(" ")}` : message;
}

function formatPrettyLogMessage(value: unknown): string {
  return typeof value === "string" ? value : formatPrettyValue(value);
}

function prettyFieldLabel(field: (typeof PRETTY_INLINE_FIELDS)[number]): string {
  return field === "durationMs" ? "duration" : field;
}

function formatPrettyFieldValue(
  field: (typeof PRETTY_INLINE_FIELDS)[number],
  value: unknown,
): string {
  const formatted = formatPrettyValue(value);
  return field === "durationMs" && typeof value === "number" ? `${formatted}ms` : formatted;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return isBarePrettyValue(value) ? value : JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  return JSON.stringify(value) ?? String(value);
}

function isBarePrettyValue(value: string): boolean {
  return /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(value);
}

function isLogFormat(value: string): value is LogFormat {
  return (LOG_FORMATS as readonly string[]).includes(value);
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
