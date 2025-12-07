/**
 * Structured logger for MCP Arduino ESP32
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.MCP_LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, module: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}${dataStr}`;
}

export function createLogger(module: string) {
  return {
    debug: (message: string, data?: unknown) => {
      if (shouldLog('debug')) {
        console.debug(formatMessage('debug', module, message, data));
      }
    },
    info: (message: string, data?: unknown) => {
      if (shouldLog('info')) {
        console.info(formatMessage('info', module, message, data));
      }
    },
    warn: (message: string, data?: unknown) => {
      if (shouldLog('warn')) {
        console.warn(formatMessage('warn', module, message, data));
      }
    },
    error: (message: string, data?: unknown) => {
      if (shouldLog('error')) {
        console.error(formatMessage('error', module, message, data));
      }
    },
  };
}

export const logger = createLogger('ArduinoMCP');

