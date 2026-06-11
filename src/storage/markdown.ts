import { sectionHeading, type MemorySection } from "./templates.ts";

/**
 * Lightweight section-aware model of a MEMORY.md document.
 *
 * The document is a title line followed by `## <heading>` sections, each
 * containing `- ` bullet items. We parse into a map of heading -> items so we
 * can merge new facts into the right section with dedup, then re-serialize in
 * canonical order. Unknown sections (e.g. hand-added "Project context") are
 * preserved verbatim.
 */
export interface ParsedMemory {
  title: string;
  /** heading -> list of bullet item texts (without the leading "- "). */
  sections: Map<string, string[]>;
  /** Headings in their original encounter order. */
  order: string[];
}

export function parseMemory(content: string): ParsedMemory {
  const lines = content.split(/\r?\n/);
  let title = "";
  const sections = new Map<string, string[]>();
  const order: string[] = [];
  let current: string | undefined;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = h2[1]!;
      if (!sections.has(current)) {
        sections.set(current, []);
        order.push(current);
      }
      continue;
    }
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1 && title === "") {
      title = line.replace(/\s+$/, "");
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet && current) {
      const text = bullet[1]!.trim();
      if (text.length > 0) sections.get(current)!.push(text);
    }
  }

  return { title, sections, order };
}

/**
 * Normalize a string for similarity comparison: lowercased, collapsed
 * whitespace, stripped of surrounding markdown noise.
 */
function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cheap text similarity (Jaccard over word sets). Avoids pulling in a fuzzy
 * library; good enough to catch near-duplicate one-liners.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return 1;
  const sa = new Set(na.split(" ").filter(Boolean));
  const sb = new Set(nb.split(" ").filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

const DEDUP_THRESHOLD = 0.85;

export interface MergeOutcome {
  action: "added" | "updated" | "duplicate";
}

/**
 * Merge a new fact into the given section. If a near-duplicate already exists
 * we update it in place (longer/newer text wins) rather than appending,
 * keeping the document compact.
 */
export function mergeFact(
  doc: ParsedMemory,
  section: MemorySection,
  content: string,
): MergeOutcome {
  const heading = sectionHeading(section);
  const text = content.trim();
  if (!doc.sections.has(heading)) {
    doc.sections.set(heading, []);
    doc.order.push(heading);
  }
  const items = doc.sections.get(heading)!;

  for (let i = 0; i < items.length; i++) {
    const sim = similarity(items[i]!, text);
    if (sim >= DEDUP_THRESHOLD) {
      if (normalizeForCompare(items[i]!) === normalizeForCompare(text)) {
        return { action: "duplicate" };
      }
      // Near-duplicate: keep the more informative (longer) version.
      if (text.length > items[i]!.length) items[i] = text;
      return { action: "updated" };
    }
  }

  items.push(text);
  return { action: "added" };
}

/**
 * Serialize back to markdown. Known sections are emitted in canonical order
 * first (only if non-empty), then any extra/unknown sections in their original
 * order. Empty known sections are omitted to avoid clutter.
 */
export function serializeMemory(
  doc: ParsedMemory,
  canonicalOrder: string[],
): string {
  const out: string[] = [];
  out.push(doc.title || "# Memory");
  out.push("");

  const emitted = new Set<string>();

  const emit = (heading: string) => {
    const items = doc.sections.get(heading);
    if (!items || items.length === 0) return;
    out.push(`## ${heading}`);
    out.push("");
    for (const item of items) out.push(`- ${item}`);
    out.push("");
    emitted.add(heading);
  };

  for (const heading of canonicalOrder) emit(heading);
  for (const heading of doc.order) {
    if (!emitted.has(heading)) emit(heading);
  }

  // Single trailing newline.
  return out.join("\n").replace(/\n+$/, "\n");
}
