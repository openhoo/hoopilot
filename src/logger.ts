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
    return pino(
      pinoOptions,
      pretty({
        colorize: options.colorize ?? process.stderr.isTTY,
        destination: options.stream ?? 1,
        ignore: "pid,hostname",
        singleLine: true,
        translateTime: "SYS:standard",
      }),
    ) as HoopilotLogger;
  }

  if (options.stream) {
    return pino(pinoOptions, options.stream as pino.DestinationStream) as HoopilotLogger;
  }
  return pino(pinoOptions) as HoopilotLogger;
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

function isLogFormat(value: string): value is LogFormat {
  return (LOG_FORMATS as readonly string[]).includes(value);
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
