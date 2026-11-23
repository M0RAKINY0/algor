import { pino, type DestinationStream, type LoggerOptions } from 'pino';
import { env } from '../config/env.js';

export const LOGGER_REDACT: LoggerOptions['redact'] = {
  paths: [
    'req.headers["x-admin-key"]',
    'req.headers.authorization',
    'req.headers.cookie',
    'headers["x-admin-key"]',
    'headers.authorization',
    'headers.cookie',
  ],
  censor: '[REDACTED]',
};

export function createLogger(overrides: LoggerOptions = {}, destination?: DestinationStream) {
  const options: LoggerOptions = {
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: LOGGER_REDACT,
    ...(!destination &&
      env.NODE_ENV === 'development' && {
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }),
    ...overrides,
  };

  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
