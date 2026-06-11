import type { Database } from "./storage/sqlite.ts";
import type { MemoryStore } from "./store.ts";

/**
 * Lightweight usage counters for the memory plugin (M5).
 *
 * Stored as a single-row-per-key tally in the plugin's own SQLite index
 * (`memory_metric` table; schema in storage/index-db.ts). Purpose is to answer
 * "is this thing actually being used, and is it working" during the
 * trial-period — e.g. a high `search.zero_hits` / `search.count` ratio means
 * tokenization or the score floor needs tuning.
 *
 * Hard guarantee: a metrics failure must never affect a tool call. Every write
 * is wrapped so it can't throw. Gated by `config.metrics.enabled`.
 */

/** Known metric keys. Free-form is allowed, but listing the common ones keeps usage consistent. */
export type MetricKey =
  | "remember.added"
  | "remember.updated"
  | "remember.duplicate"
  | "remember.global"
  | "search.count"
  | "search.zero_hits"
  | "checkpoint.saved"
  | "note.added"
  | "dream.run"
  | "dream.skip"
  | "distill.run"
  | "distill.skip";

export interface MetricRow {
  key: string;
  count: number;
  updated_at: number;
}

/**
 * Increment a counter by `n` (default 1). No-op (swallows) on any error so a
 * metrics write can never break the caller.
 */
export function bump(store: MemoryStore, key: MetricKey | string, n = 1): void {
  if (!store.config.metrics.enabled) return;
  try {
    const db = store.index();
    db.query(
      `INSERT INTO memory_metric(key, count, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = count + excluded.count,
         updated_at = excluded.updated_at`,
    ).run(key, n, Date.now());
  } catch {
    // Metrics must never throw into the caller.
  }
}

/** Read all counters, ordered by key. Returns [] on any error. */
export function readAll(db: Database): MetricRow[] {
  try {
    return db
      .query<MetricRow, []>(
        "SELECT key, count, updated_at FROM memory_metric ORDER BY key",
      )
      .all();
  } catch {
    return [];
  }
}

/** Format counters as a compact human-readable report for the memory_stats tool. */
export function formatStats(rows: MetricRow[]): string {
  if (rows.length === 0) return "暂无统计数据（还没有任何记忆操作，或指标已关闭）。";

  const get = (k: string): number => rows.find((r) => r.key === k)?.count ?? 0;

  const searchCount = get("search.count");
  const zeroHits = get("search.zero_hits");
  const zeroPct =
    searchCount > 0 ? ` (${Math.round((zeroHits / searchCount) * 100)}% 零命中)` : "";

  const lines = [
    "记忆使用统计：",
    "",
    "写入：",
    `  remember_fact  新增 ${get("remember.added")} / 更新 ${get("remember.updated")} / 重复跳过 ${get("remember.duplicate")}（其中全局 ${get("remember.global")}）`,
    `  save_checkpoint ${get("checkpoint.saved")}`,
    `  note            ${get("note.added")}`,
    "",
    "检索：",
    `  memory_search   ${searchCount} 次${zeroPct}`,
    "",
    "收敛：",
    `  /dream   运行 ${get("dream.run")} / 跳过 ${get("dream.skip")}`,
    `  /distill 运行 ${get("distill.run")} / 跳过 ${get("distill.skip")}`,
  ];
  return lines.join("\n");
}
