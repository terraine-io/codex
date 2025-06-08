import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5
}

interface Logger {
  /** Checking this can be used to avoid constructing a large log message. */
  isLoggingEnabled(): boolean;
  
  /** Check if a specific log level is enabled */
  isLevelEnabled(level: LogLevel): boolean;

  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  trace(message: string): void;
}

class AsyncLogger implements Logger {
  private queue: Array<string> = [];
  private isWriting: boolean = false;
  private currentLevel: LogLevel;

  constructor(private filePath: string, level: LogLevel) {
    this.filePath = filePath;
    this.currentLevel = level;
  }

  isLoggingEnabled(): boolean {
    return this.currentLevel > LogLevel.NONE;
  }
  
  isLevelEnabled(level: LogLevel): boolean {
    return this.currentLevel >= level;
  }

  private writeLog(level: string, message: string): void {
    if (!this.isLoggingEnabled()) return;
    const entry = `[${now()}] [${level}] ${message}\n`;
    this.queue.push(entry);
    this.maybeWrite();
  }

  log(message: string): void {
    this.writeLog('INFO', message);
  }
  
  error(message: string): void {
    if (this.isLevelEnabled(LogLevel.ERROR)) {
      this.writeLog('ERROR', message);
    }
  }
  
  warn(message: string): void {
    if (this.isLevelEnabled(LogLevel.WARN)) {
      this.writeLog('WARN', message);
    }
  }
  
  info(message: string): void {
    if (this.isLevelEnabled(LogLevel.INFO)) {
      this.writeLog('INFO', message);
    }
  }
  
  debug(message: string): void {
    if (this.isLevelEnabled(LogLevel.DEBUG)) {
      this.writeLog('DEBUG', message);
    }
  }
  
  trace(message: string): void {
    if (this.isLevelEnabled(LogLevel.TRACE)) {
      this.writeLog('TRACE', message);
    }
  }

  private async maybeWrite(): Promise<void> {
    if (this.isWriting || this.queue.length === 0) {
      return;
    }

    this.isWriting = true;
    const messages = this.queue.join("");
    this.queue = [];

    try {
      await fs.appendFile(this.filePath, messages);
    } finally {
      this.isWriting = false;
    }

    this.maybeWrite();
  }
}

class EmptyLogger implements Logger {
  isLoggingEnabled(): boolean {
    return false;
  }
  
  isLevelEnabled(_level: LogLevel): boolean {
    return false;
  }

  log(_message: string): void {
    // No-op
  }
  
  error(_message: string): void {
    // No-op
  }
  
  warn(_message: string): void {
    // No-op
  }
  
  info(_message: string): void {
    // No-op
  }
  
  debug(_message: string): void {
    // No-op
  }
  
  trace(_message: string): void {
    // No-op
  }
}

function now() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

let logger: Logger;

function parseLogLevel(levelStr: string | undefined): LogLevel {
  if (!levelStr) return LogLevel.NONE;
  
  const level = levelStr.toLowerCase();
  switch (level) {
    case 'error': return LogLevel.ERROR;
    case 'warn': case 'warning': return LogLevel.WARN;
    case 'info': return LogLevel.INFO;
    case 'debug': return LogLevel.DEBUG;
    case 'trace': return LogLevel.TRACE;
    case 'none': case 'off': return LogLevel.NONE;
    default:
      // For backward compatibility, treat any truthy DEBUG value as INFO level
      return level === 'true' || level === '1' ? LogLevel.INFO : LogLevel.NONE;
  }
}

/**
 * Creates a .log file for this session, but also symlinks codex-cli-latest.log
 * to the current log file so you can reliably run:
 *
 * - Mac/Windows: `tail -F "$TMPDIR/oai-codex/codex-cli-latest.log"`
 * - Linux: `tail -F ~/.local/oai-codex/codex-cli-latest.log`
 * 
 * Log levels can be controlled with DEBUG or LOG_LEVEL environment variables:
 * - DEBUG=true (backward compatibility, sets INFO level)
 * - LOG_LEVEL=debug (sets DEBUG level)
 * - LOG_LEVEL=trace (sets TRACE level - most verbose)
 */
export function initLogger(): Logger {
  if (logger) {
    return logger;
  }
  
  // Check LOG_LEVEL first, then fall back to DEBUG for backward compatibility
  const logLevel = parseLogLevel(process.env["LOG_LEVEL"] || process.env["DEBUG"]);
  
  if (logLevel === LogLevel.NONE) {
    logger = new EmptyLogger();
    return logger;
  }

  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  // On Mac and Windows, os.tmpdir() returns a user-specific folder, so prefer
  // it there. On Linux, use ~/.local/oai-codex so logs are not world-readable.
  const logDir =
    isMac || isWin
      ? path.join(os.tmpdir(), "oai-codex")
      : path.join(os.homedir(), ".local", "oai-codex");
  fsSync.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `codex-cli-${now()}.log`);
  // Write the empty string so the file exists and can be tail'd.
  fsSync.writeFileSync(logFile, "");

  // Symlink to codex-cli-latest.log on UNIX because Windows is funny about
  // symlinks.
  if (!isWin) {
    const latestLink = path.join(logDir, "codex-cli-latest.log");
    try {
      fsSync.symlinkSync(logFile, latestLink, "file");
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        fsSync.unlinkSync(latestLink);
        fsSync.symlinkSync(logFile, latestLink, "file");
      } else {
        throw err;
      }
    }
  }

  logger = new AsyncLogger(logFile, logLevel);
  return logger;
}

export function log(message: string): void {
  (logger ?? initLogger()).log(message);
}

export function error(message: string): void {
  (logger ?? initLogger()).error(message);
}

export function warn(message: string): void {
  (logger ?? initLogger()).warn(message);
}

export function info(message: string): void {
  (logger ?? initLogger()).info(message);
}

export function debug(message: string): void {
  (logger ?? initLogger()).debug(message);
}

export function trace(message: string): void {
  (logger ?? initLogger()).trace(message);
}

/**
 * USE SPARINGLY! This function should only be used to guard a call to log() if
 * the log message is large and you want to avoid constructing it if logging is
 * disabled.
 *
 * `log()` is already a no-op if DEBUG is not set, so an extra
 * `isLoggingEnabled()` check is unnecessary.
 */
export function isLoggingEnabled(): boolean {
  return (logger ?? initLogger()).isLoggingEnabled();
}

/**
 * Check if a specific log level is enabled. Useful for guarding expensive log message construction.
 * 
 * @example
 * if (isLevelEnabled(LogLevel.TRACE)) {
 *   trace(`Expensive data: ${JSON.stringify(largeObject, null, 2)}`);
 * }
 */
export function isLevelEnabled(level: LogLevel): boolean {
  return (logger ?? initLogger()).isLevelEnabled(level);
}
