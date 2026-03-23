/**
 * Structured logger for fpdf. Replaces bare console calls throughout the codebase.
 * All output goes to stderr except info/log which go to stdout so that
 * machine-readable output (e.g. the server URL) can be piped independently.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Messages from third-party libraries we intentionally suppress.
const SUPPRESSED_WARN_PATTERNS = [/Removing XFA form data as pdf-lib does not support/];

/**
 * Install a console.warn filter that drops known noisy third-party messages.
 * Call once at startup. Safe to call multiple times (idempotent).
 */
let warnFilterInstalled = false;
export function installWarnFilter(): void {
  if (warnFilterInstalled) return;
  warnFilterInstalled = true;
  // eslint-disable-next-line no-console
  const orig = console.warn.bind(console);
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => {
    const msg = args.length > 0 ? String(args[0]) : '';
    if (SUPPRESSED_WARN_PATTERNS.some((re) => re.test(msg))) return;
    orig(...args);
  };
}

/**
 * Ensure the warn filter is active, then run `fn`, returning its result.
 * Convenience wrapper so call-sites don't need to call installWarnFilter()
 * separately before every PDFDocument.load().
 */
export async function withSilencedWarn<T>(fn: () => Promise<T>): Promise<T> {
  installWarnFilter();
  return fn();
}

export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

function formatMessage(level: LogLevel, msg: string): string {
  return `[fpdf:${level}] ${msg}`;
}

export const logger: Logger = {
  debug(msg, ...args) {
    if (process.env.FPDF_DEBUG === '1') {
      process.stderr.write(formatMessage('debug', msg) + '\n');
      if (args.length > 0) {
        process.stderr.write(JSON.stringify(args) + '\n');
      }
    }
  },
  info(msg, ...args) {
    process.stdout.write(formatMessage('info', msg) + '\n');
    if (args.length > 0) {
      process.stdout.write(JSON.stringify(args) + '\n');
    }
  },
  warn(msg, ...args) {
    process.stderr.write(formatMessage('warn', msg) + '\n');
    if (args.length > 0) {
      process.stderr.write(JSON.stringify(args) + '\n');
    }
  },
  error(msg, ...args) {
    process.stderr.write(formatMessage('error', msg) + '\n');
    if (args.length > 0) {
      process.stderr.write(JSON.stringify(args) + '\n');
    }
  },
};
