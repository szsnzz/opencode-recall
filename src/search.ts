import type { Database } from "./storage/sqlite.ts";

import { buildMatchQuery } from "./storage/fts-query.ts";
import { reconcile } from "./storage/reconcile.ts";
import type { MemoryStore } from "./store.ts";

export type SearchScope = "all" | "project" | "session" | "global";

export interface SearchArgs {
  query: string;
  scope?: SearchScope;
  limit?: number;
}

export interface SearchDeps {
  store: MemoryStore;
  projectId: string;
  sessionId: string;
}

export interface SearchHit {
  path: string;
  scope: string;
  scopeId: string;
  type: string;
  snippet: string;
  /** Normalized relevance score in (0, 1], higher is better. */
  score: number;
}

interface RawRow {
  path: string;
  scope: string;
  scope_id: string;
  type: string;
  snippet: string;
  /** bm25() — lower (more negative) is more relevant. */
  rank: number;
}

/**
 * Build the WHERE clause restricting which documents are visible for a given
 * scope. The default ("all") exposes project + global + the *current* session,
 * and never leaks other sessions' or projects' memories.
 */
function scopeFilter(
  scope: SearchScope,
  projectId: string,
  sessionId: string,
): { sql: string; params: string[] } {
  switch (scope) {
    case "project":
      return {
        sql: "d.scope = 'projects' AND d.scope_id = ?",
        params: [projectId],
      };
    case "global":
      return { sql: "d.scope = 'global'", params: [] };
    case "session":
      return {
        sql: "d.scope = 'sessions' AND d.scope_id = ?",
        params: [sessionId],
      };
    case "all":
    default:
      return {
        sql:
          "(d.scope = 'global' " +
          "OR (d.scope = 'projects' AND d.scope_id = ?) " +
          "OR (d.scope = 'sessions' AND d.scope_id = ?))",
        params: [projectId, sessionId],
      };
  }
}

/**
 * Convert a bm25 rank (negative, lower = better) into a normalized score in
 * (0, 1] where the best hit is 1. We invert the sign and divide by the best.
 */
function normalizeScores(rows: RawRow[]): { row: RawRow; score: number }[] {
  if (rows.length === 0) return [];
  // bm25 is <= 0; magnitude grows with relevance. Use -rank as raw relevance.
  const raws = rows.map((r) => ({ row: r, raw: -r.rank }));
  const best = Math.max(...raws.map((r) => r.raw));
  if (best <= 0) {
    // Degenerate (all zero) — treat equally.
    return raws.map((r) => ({ row: r.row, score: 1 }));
  }
  return raws.map((r) => ({ row: r.row, score: r.raw / best }));
}

/**
 * Run a memory search: reconcile the index, run FTS5 MATCH ordered by bm25,
 * apply scope isolation and the relative score floor, return high-signal hits.
 */
export async function memorySearch(
  args: SearchArgs,
  deps: SearchDeps,
): Promise<SearchHit[]> {
  const db = deps.store.index();
  await reconcile(db, deps.store.paths);

  const match = buildMatchQuery(args.query ?? "");
  if (match === "") return [];

  const scope = args.scope ?? "all";
  const limit = clampLimit(args.limit ?? deps.store.config.search.limit);
  const filter = scopeFilter(scope, deps.projectId, deps.sessionId);

  // Fetch more than `limit` so the score floor has candidates to trim.
  const fetch = Math.min(Math.max(limit * 3, limit), 100);

  const rows = queryFts(db, match, filter, fetch);
  const scored = normalizeScores(rows);

  const floor = deps.store.config.search.scoreFloor;
  const hits: SearchHit[] = [];
  for (let i = 0; i < scored.length; i++) {
    const { row, score } = scored[i]!;
    // First result is always kept; the rest must clear the relative floor.
    if (i > 0 && score < floor) continue;
    hits.push({
      path: row.path,
      scope: row.scope,
      scopeId: row.scope_id,
      type: row.type,
      snippet: row.snippet.trim(),
      score,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(Math.round(n), 1), 100);
}

function queryFts(
  db: Database,
  match: string,
  filter: { sql: string; params: string[] },
  fetch: number,
): RawRow[] {
  // snippet(): column 0 (body), '[' / ']' highlight delimiters, ' ... '
  // ellipsis, 12-token window.
  const sql = `
    SELECT d.path AS path,
           d.scope AS scope,
           d.scope_id AS scope_id,
           d.type AS type,
           snippet(memory_fts, 0, '[', ']', ' ... ', 12) AS snippet,
           bm25(memory_fts) AS rank
      FROM memory_fts
      JOIN memory_doc d ON d.id = memory_fts.rowid
     WHERE memory_fts MATCH ?
       AND ${filter.sql}
     ORDER BY rank ASC
     LIMIT ?
  `;
  return db
    .query<RawRow, (string | number)[]>(sql)
    .all(match, ...filter.params, fetch) as RawRow[];
}
