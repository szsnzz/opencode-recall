/**
 * Build a safe FTS5 MATCH expression from arbitrary user input.
 *
 * FTS5's query syntax treats characters like `"`, `*`, `(`, `:`, `-`, `^`, `.`
 * as operators. Passing raw user text straight to MATCH crashes the parser or
 * silently mis-parses. We therefore:
 *   1. Split on anything that isn't a unicode letter/number.
 *   2. Wrap each token as a quoted phrase ("token") to neutralize operators.
 *   3. Join with OR so partial matches still surface candidates.
 *
 * The OR side effect (documents matching only a common word also match) is
 * handled downstream by the relative score floor in the search layer.
 */
export function buildMatchQuery(rawQuery: string): string {
  const tokens = tokenize(rawQuery);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Tokenize a string into lowercase alphanumeric runs. Unicode letters/numbers
 * are kept (so CJK and accented text survive); everything else is a separator.
 */
export function tokenize(raw: string): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  // \p{L} letters, \p{N} numbers. Anything else splits.
  const matches = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!matches) return [];
  // Dedupe while preserving order; cap to avoid pathological huge queries.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
    if (out.length >= 64) break;
  }
  return out;
}
