import { sectionHeading, type MemorySection } from "./templates.ts";
import {
  CHECKPOINT_SECTIONS,
  checkpointDef,
  checkpointTitle,
  truncateToBudget,
  type CheckpointField,
} from "./templates.ts";

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

// ---------------------------------------------------------------------------
// Checkpoint document model (session-level). See DESIGN.md §3.2.
//
// Unlike MEMORY.md, a checkpoint has a fixed set of sections keyed by heading.
// Each section is either a free-text block or a bullet list ("涉及文件"). On
// update, text blocks are replaced with the newest content; list sections get
// new items deduped and appended. Every section is clamped to its token budget.
// ---------------------------------------------------------------------------

const HEADING_BY_FIELD: Record<CheckpointField, string> = Object.fromEntries(
  CHECKPOINT_SECTIONS.map((s) => [s.key, s.heading]),
) as Record<CheckpointField, string>;

const FIELD_BY_HEADING: Record<string, CheckpointField> = Object.fromEntries(
  CHECKPOINT_SECTIONS.map((s) => [s.heading, s.key]),
);

export interface CheckpointUpdate {
  intent?: string;
  next_action?: string;
  current_work?: string;
  files?: string[];
  discovered?: string;
  errors_fixes?: string;
  decisions?: string;
  open_questions?: string;
}

/**
 * Parsed checkpoint: per-field content. Text fields hold a single string; the
 * `files` list field holds an array of bullet items.
 */
export interface ParsedCheckpoint {
  text: Map<CheckpointField, string>;
  files: string[];
}

export function parseCheckpoint(content: string): ParsedCheckpoint {
  const text = new Map<CheckpointField, string>();
  let files: string[] = [];
  if (!content) return { text, files };

  const lines = content.split(/\r?\n/);
  let currentField: CheckpointField | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (currentField === undefined) return;
    if (currentField === "files") {
      // list section handled inline; nothing buffered as text
    } else {
      const body = buffer.join("\n").trim();
      if (body.length > 0) text.set(currentField, body);
    }
    buffer = [];
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      const field = FIELD_BY_HEADING[h2[1]!];
      currentField = field;
      continue;
    }
    if (currentField === undefined) continue;
    if (line.match(/^#\s+/)) continue; // title line
    if (currentField === "files") {
      const bullet = line.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        const t = bullet[1]!.trim();
        if (t) files.push(t);
      }
    } else {
      buffer.push(line);
    }
  }
  flush();

  return { text, files };
}

export interface CheckpointMergeResult {
  /** Fields that were written/changed by this update. */
  changed: CheckpointField[];
}

/**
 * Apply an update onto a parsed checkpoint. Text fields replace prior content;
 * the files list dedupes and appends. Each field is truncated to its budget.
 */
export function mergeCheckpoint(
  doc: ParsedCheckpoint,
  update: CheckpointUpdate,
): CheckpointMergeResult {
  const changed: CheckpointField[] = [];

  const setText = (field: CheckpointField, value: string | undefined) => {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const budget = checkpointDef(field).tokenBudget;
    doc.text.set(field, truncateToBudget(trimmed, budget));
    changed.push(field);
  };

  setText("intent", update.intent);
  setText("next_action", update.next_action);
  setText("current_work", update.current_work);
  setText("discovered", update.discovered);
  setText("errors_fixes", update.errors_fixes);
  setText("decisions", update.decisions);
  setText("open_questions", update.open_questions);

  if (update.files && update.files.length > 0) {
    const seen = new Set(doc.files.map((f) => normalizeForCompare(f)));
    let added = false;
    for (const raw of update.files) {
      const f = raw.trim();
      if (!f) continue;
      const norm = normalizeForCompare(f);
      if (seen.has(norm)) continue;
      seen.add(norm);
      doc.files.push(f);
      added = true;
    }
    if (added) {
      // Clamp the whole list to its budget by dropping oldest entries.
      const budget = checkpointDef("files").tokenBudget;
      while (
        doc.files.length > 1 &&
        approxBudgetOfList(doc.files) > budget
      ) {
        doc.files.shift();
      }
      changed.push("files");
    }
  }

  return { changed };
}

function approxBudgetOfList(items: string[]): number {
  // Reuse the same heuristic as templates.approxTokens without importing it
  // into a hot loop: chars/4 dominates for bullet lists.
  let chars = 0;
  for (const i of items) chars += i.length + 2;
  return Math.ceil(chars / 4);
}

/** Serialize a checkpoint back to markdown in canonical section order. */
export function serializeCheckpoint(doc: ParsedCheckpoint): string {
  const out: string[] = [checkpointTitle(), ""];
  for (const def of CHECKPOINT_SECTIONS) {
    if (def.key === "files") {
      if (doc.files.length === 0) continue;
      out.push(`## ${def.heading}`, "");
      for (const f of doc.files) out.push(`- ${f}`);
      out.push("");
    } else {
      const body = doc.text.get(def.key);
      if (!body || body.trim().length === 0) continue;
      out.push(`## ${def.heading}`, "", body.trim(), "");
    }
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

export { HEADING_BY_FIELD };
