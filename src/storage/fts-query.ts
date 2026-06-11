/**
 * Build a safe FTS5 MATCH expression from arbitrary user input.
 *
 * FTS5's query syntax treats characters like `"`, `*`, `(`, `:`, `-`, `^`, `.`
 * as operators. Passing raw user text straight to MATCH crashes the parser or
 * silently mis-parses. We therefore:
 *   1. CJK-segment the query (so "简洁" -> bigram "简洁", "提交信息" ->
 *      "提交" "交信" "信息") to mirror how the `search` column was indexed.
 *   2. Split on anything that isn't a unicode letter/number/underscore.
 *   3. Wrap each token as a quoted phrase ("token") to neutralize operators.
 *   4. Restrict the match to the `search` column and OR-join the tokens so
 *      partial matches still surface candidates.
 *
 * The OR side effect (documents matching only a common word also match) is
 * handled downstream by the relative score floor in the search layer.
 */
import { segment } from "./segment.ts";

/** FTS column that holds the CJK-segmented text we actually match against. */
export const SEARCH_COLUMN = "search";

export function buildMatchQuery(rawQuery: string): string {
  const tokens = tokenize(rawQuery);
  if (tokens.length === 0) return "";
  const ors = tokens.map((t) => `"${t}"`).join(" OR ");
  // Column filter: only match the segmented `search` column, not `body`.
  return `{${SEARCH_COLUMN}} : (${ors})`;
}

/**
 * Tokenize a string into lowercase tokens after CJK segmentation. CJK runs are
 * expanded to bigrams by `segment`; the result is then split on non-word
 * characters. Underscore is kept so identifiers like `save_checkpoint` stay
 * intact (matching what unicode61 does NOT split). Quotes are stripped to keep
 * the phrase wrapper safe.
 */
export function tokenize(raw: string): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const segmented = segment(raw);
  const matches = segmented.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches) return [];
  // Dedupe while preserving order; cap to avoid pathological huge queries.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const t = m.replaceAll('"', "");
    if (t.length === 0) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= 64) break;
  }
  return out;
}
