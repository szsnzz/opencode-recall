/**
 * CJK-aware segmentation for FTS5.
 *
 * The `unicode61` tokenizer treats a run of contiguous CJK characters as a
 * SINGLE token (it only breaks on non-alphanumeric separators, and CJK has no
 * spaces). That makes substring search impossible: storing "并且简洁" indexes
 * one token, so a query for "简洁" never matches. This is a known limitation
 * shared with MiMo Code.
 *
 * We work around it WITHOUT swapping the tokenizer (keeping english stemming
 * behavior and parser stability) by pre-segmenting text before it reaches the
 * FTS index, and applying the exact same segmentation to queries:
 *
 *   - A run of CJK characters is expanded into overlapping bigrams:
 *       "并且简洁" -> "并且 且简 简洁"
 *     so any 2+ character CJK substring becomes matchable.
 *   - A lone CJK character is kept as-is.
 *   - Runs of non-CJK text (english words, identifiers like save_checkpoint,
 *     numbers, punctuation) are kept verbatim so unicode61 tokenizes them
 *     normally — english recall and identifier search are unaffected.
 *
 * Because indexing and querying both go through `segment`, the bigram on each
 * side lines up and matches. The original text is stored separately (the FTS
 * `body` column) so snippets still show human-readable, un-segmented text.
 */

// CJK ranges: CJK Unified + Ext-A, compatibility ideographs, Hiragana,
// Katakana, and Hangul syllables. Covers Chinese, Japanese kana, Korean.
const CJK_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;

export function isCJKChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

/**
 * Segment text for FTS: CJK runs become space-joined overlapping bigrams,
 * non-CJK runs are preserved verbatim. The result is a space-separated string
 * suitable for feeding into the FTS `search` column or a MATCH query builder.
 */
export function segment(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const chars = Array.from(text);
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (isCJKChar(chars[i]!)) {
      let j = i;
      while (j < chars.length && isCJKChar(chars[j]!)) j++;
      const run = chars.slice(i, j);
      if (run.length === 1) {
        out.push(run[0]!);
      } else {
        for (let k = 0; k < run.length - 1; k++) {
          out.push(run[k]! + run[k + 1]!);
        }
      }
      i = j;
    } else {
      let j = i;
      while (j < chars.length && !isCJKChar(chars[j]!)) j++;
      out.push(chars.slice(i, j).join(""));
      i = j;
    }
  }
  return out.join(" ");
}
