import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

/**
 * Resolved memory configuration. All fields are concrete (no optionals) so the
 * rest of the codebase never has to re-apply defaults.
 */
export interface MemoryConfig {
  enabled: boolean;
  /** Absolute path to the memory root directory. */
  root: string;
  search: {
    /** Keep results scoring >= topScore * scoreFloor (first result always kept). */
    scoreFloor: number;
    /** Default number of results returned by memory_search. */
    limit: number;
  };
  dream: { intervalDays: number };
  distill: { intervalDays: number };
  /** Diagnostic logging via opencode's app log channel. */
  log: { level: LogLevel };
  /** Lightweight usage counters stored in the plugin's own SQLite index. */
  metrics: { enabled: boolean };
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Raw, untrusted shape as it may appear in opencode.json under the `memory` key. */
export interface RawMemoryConfig {
  enabled?: boolean;
  root?: string;
  search?: {
    scoreFloor?: number;
    defaultScope?: string;
    limit?: number;
  };
  dream?: { intervalDays?: number };
  distill?: { intervalDays?: number };
  log?: { level?: string };
  metrics?: { enabled?: boolean };
}

export const DEFAULT_MEMORY_ROOT = "~/.config/opencode/memory";

/**
 * Load the plugin's raw config from its own file, layered with env overrides.
 *
 * Source order (later wins):
 *   1. `<projectRoot>/.opencode/memory.json`  — project-local config
 *   2. env `OPENCODE_MEMORY_ROOT`             — override the memory root
 *   3. env `OPENCODE_MEMORY_DISABLED=1`       — hard disable
 *
 * We intentionally avoid opencode.json: upstream opencode rejects unknown
 * top-level keys there, so a `memory` block would break the whole session.
 */
export function loadRawConfig(projectRoot: string): RawMemoryConfig {
  let fileConfig: RawMemoryConfig = {};
  try {
    const file = resolve(projectRoot, ".opencode", "memory.json");
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      fileConfig = parsed as RawMemoryConfig;
    }
  } catch {
    // No file / invalid JSON -> defaults. Never throw from config loading.
  }

  const envRoot = process.env["OPENCODE_MEMORY_ROOT"];
  if (typeof envRoot === "string" && envRoot.trim().length > 0) {
    fileConfig.root = envRoot;
  }
  if (process.env["OPENCODE_MEMORY_DISABLED"] === "1") {
    fileConfig.enabled = false;
  }

  return fileConfig;
}

/**
 * Expand a memory root to an absolute path.
 *
 * - `~` / `~/...` expand to the user's home directory.
 * - Absolute paths are returned as-is (normalized).
 * - Relative paths resolve against `baseDir` (the project root) when provided,
 *   NOT `process.cwd()` — opencode runs with cwd set to the user's home, so a
 *   relative `root` like `./_memory_data` in a project's memory.json must be
 *   anchored to the project, otherwise it lands in the home directory.
 */
export function expandRoot(root: string, baseDir?: string): string {
  const r = root.trim();
  if (r === "~" || r === "~/" || r === "~\\") {
    return homedir();
  }
  if (r.startsWith("~/") || r.startsWith("~\\")) {
    return resolve(homedir(), r.slice(2));
  }
  if (isAbsolute(r)) {
    return resolve(r);
  }
  return resolve(baseDir ?? process.cwd(), r);
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Merge raw config with defaults and normalize into a fully-resolved
 * MemoryConfig. A relative `root` is resolved against `baseDir` (the project
 * root); see expandRoot.
 */
export function resolveConfig(
  raw: RawMemoryConfig | undefined,
  baseDir?: string,
): MemoryConfig {
  const r = raw ?? {};
  const rootRaw =
    typeof r.root === "string" && r.root.trim().length > 0
      ? r.root
      : DEFAULT_MEMORY_ROOT;

  return {
    enabled: r.enabled !== false,
    root: expandRoot(rootRaw, baseDir),
    search: {
      scoreFloor: clampNumber(r.search?.scoreFloor, 0.15, 0, 1),
      limit: Math.round(clampNumber(r.search?.limit, 10, 1, 100)),
    },
    dream: {
      intervalDays: Math.round(
        clampNumber(r.dream?.intervalDays, 7, 0, 3650),
      ),
    },
    distill: {
      intervalDays: Math.round(
        clampNumber(r.distill?.intervalDays, 30, 0, 3650),
      ),
    },
    log: { level: normalizeLogLevel(r.log?.level) },
    metrics: { enabled: r.metrics?.enabled !== false },
  };
}

/** Coerce an untrusted log level string to a valid LogLevel (default "info"). */
function normalizeLogLevel(value: unknown): LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : "info";
}
