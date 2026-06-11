import { homedir } from "node:os";
import { resolve } from "node:path";

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
}

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
}

export const DEFAULT_MEMORY_ROOT = "~/.config/opencode/memory";

/** Expand a leading `~` to the user's home directory and resolve to absolute. */
export function expandRoot(root: string): string {
  let r = root.trim();
  if (r === "~" || r === "~/" || r === "~\\") {
    return homedir();
  }
  if (r.startsWith("~/") || r.startsWith("~\\")) {
    r = resolve(homedir(), r.slice(2));
    return r;
  }
  return resolve(r);
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
 * Merge raw config (from opencode.json `memory` block) with defaults and
 * normalize into a fully-resolved MemoryConfig.
 */
export function resolveConfig(raw: RawMemoryConfig | undefined): MemoryConfig {
  const r = raw ?? {};
  const rootRaw =
    typeof r.root === "string" && r.root.trim().length > 0
      ? r.root
      : DEFAULT_MEMORY_ROOT;

  return {
    enabled: r.enabled !== false,
    root: expandRoot(rootRaw),
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
  };
}
