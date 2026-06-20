import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  userId?: string;
  chatId?: string;
  transactionId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// File transport (daily rotation)
// ---------------------------------------------------------------------------

const LOG_DIR = join(process.cwd(), 'logs');

/** Derive today's log filename in YYYY-MM-DD form (local timezone). */
function todayLogFile(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `moneybot-${yyyy}-${mm}-${dd}.log`;
}

let logDirEnsured = false;

/** Best-effort async append to the daily log file. Never throws. */
function appendToFile(json: string): void {
  const file = join(LOG_DIR, todayLogFile());
  const line = json + '\n';

  if (logDirEnsured) {
    appendFile(file, line).catch(() => {});
    return;
  }

  mkdir(LOG_DIR, { recursive: true })
    .then(() => {
      logDirEnsured = true;
      return appendFile(file, line);
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Structured JSON logger. info/warn/debug → console.log; error → console.error.
 *  Every entry also gets appended to `logs/moneybot-YYYY-MM-DD.log`
 *  (daily rotation; fire-and-forget — never blocks or throws). */
export function logEvent(level: LogLevel, message: string, context?: LogContext): void {
  const entry = { timestamp: new Date().toISOString(), level, message, ...context };
  const json = JSON.stringify(entry);
  if (level === 'error') console.error(json);
  else console.log(json);
  appendToFile(json);
}
