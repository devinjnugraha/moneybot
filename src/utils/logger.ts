export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  userId?: string;
  chatId?: string;
  transactionId?: string;
  [key: string]: unknown;
}

/** Structured JSON logger. info/warn/debug → console.log; error → console.error.
 *  Every entry gets timestamp, level, message + any context fields (NFR-07). */
export function logEvent(level: LogLevel, message: string, context?: LogContext): void {
  const entry = { timestamp: new Date().toISOString(), level, message, ...context };
  const json = JSON.stringify(entry);
  if (level === 'error') console.error(json);
  else console.log(json);
}
