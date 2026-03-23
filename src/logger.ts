/**
 * Structured logger for fpdf. Replaces bare console calls throughout the codebase.
 * All output goes to stderr except info/log which go to stdout so that
 * machine-readable output (e.g. the server URL) can be piped independently.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
