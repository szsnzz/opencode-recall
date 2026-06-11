import type { createOpencodeClient } from "@opencode-ai/sdk";

import type { LogLevel } from "./config.ts";

type Client = ReturnType<typeof createOpencodeClient>;

const SERVICE = "memory";
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Diagnostic logger for the memory plugin.
 *
 * Routes to opencode's own log channel (`client.app.log`) so entries land in
 * the same log file as the rest of opencode. Two hard guarantees:
 *   1. Never throws / never blocks — logging is fire-and-forget; any failure
 *      (HTTP error, missing client) is swallowed. A logging fault must never
 *      affect a tool call.
 *   2. Level-gated — entries below the configured threshold are dropped before
 *      any work happens, so `debug` logging can stay verbose without cost.
 *
 * Falls back to `console` when no client is available (e.g. unit tests).
 */
export class Logger {
  private readonly client: Client | undefined;
  private readonly threshold: number;

  constructor(client: Client | undefined, level: LogLevel) {
    this.client = client;
    this.threshold = RANK[level];
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.emit("debug", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.emit("info", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.emit("warn", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.emit("error", message, extra);
  }

  private emit(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (RANK[level] < this.threshold) return;
    try {
      if (this.client?.app?.log) {
        // Fire-and-forget: do not await, and swallow any rejection.
        void Promise.resolve(
          this.client.app.log({ body: { service: SERVICE, level, message, extra } }),
        ).catch(() => {});
        return;
      }
      // No client (tests / degraded): fall back to console.
      const line = `[${SERVICE}:${level}] ${message}`;
      if (level === "error") console.error(line, extra ?? "");
      else if (level === "warn") console.warn(line, extra ?? "");
      else console.log(line, extra ?? "");
    } catch {
      // A logger must never throw.
    }
  }
}
