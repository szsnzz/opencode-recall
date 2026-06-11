/**
 * MEMORY.md section model (project + global). Minimal slice needed for M1's
 * remember_fact; the full checkpoint template arrives in M2.
 */

export type MemorySection =
  | "rule"
  | "architecture_decision"
  | "durable_knowledge"
  | "pattern"
  | "gotcha";

/** Display heading for each section, in canonical document order. */
export const MEMORY_SECTIONS: { key: MemorySection; heading: string }[] = [
  { key: "rule", heading: "Rules" },
  { key: "architecture_decision", heading: "Architecture decisions" },
  { key: "durable_knowledge", heading: "Discovered durable knowledge" },
  { key: "pattern", heading: "Patterns" },
  { key: "gotcha", heading: "Gotchas" },
];

const HEADING_BY_KEY: Record<MemorySection, string> = Object.fromEntries(
  MEMORY_SECTIONS.map((s) => [s.key, s.heading]),
) as Record<MemorySection, string>;

export function sectionHeading(key: MemorySection): string {
  return HEADING_BY_KEY[key];
}

/** Title line for a fresh memory document. */
export function memoryTitle(scope: "project" | "global"): string {
  return scope === "global" ? "# Global memory" : "# Project memory";
}

// ---------------------------------------------------------------------------
// Checkpoint template (session-level state). See DESIGN.md §3.2.
// ---------------------------------------------------------------------------

export type CheckpointField =
  | "intent"
  | "next_action"
  | "current_work"
  | "files"
  | "discovered"
  | "errors_fixes"
  | "decisions"
  | "open_questions";

export interface CheckpointSectionDef {
  key: CheckpointField;
  heading: string;
  /** Soft per-section budget in approximate tokens. Content over budget is truncated. */
  tokenBudget: number;
  /** files is a bullet list; the rest are free-text blocks. */
  list?: boolean;
}

/** Canonical checkpoint sections, in document order, with soft token budgets. */
export const CHECKPOINT_SECTIONS: CheckpointSectionDef[] = [
  { key: "intent", heading: "当前意图", tokenBudget: 500 },
  { key: "next_action", heading: "下一步", tokenBudget: 800 },
  { key: "current_work", heading: "当前工作", tokenBudget: 2000 },
  { key: "files", heading: "涉及文件", tokenBudget: 1500, list: true },
  { key: "discovered", heading: "发现的知识", tokenBudget: 2000 },
  { key: "errors_fixes", heading: "错误与修复", tokenBudget: 1500 },
  { key: "decisions", heading: "设计决策", tokenBudget: 2000 },
  { key: "open_questions", heading: "开放问题", tokenBudget: 800 },
];

const CHECKPOINT_DEF_BY_KEY: Record<CheckpointField, CheckpointSectionDef> =
  Object.fromEntries(CHECKPOINT_SECTIONS.map((s) => [s.key, s])) as Record<
    CheckpointField,
    CheckpointSectionDef
  >;

export function checkpointDef(key: CheckpointField): CheckpointSectionDef {
  return CHECKPOINT_DEF_BY_KEY[key];
}

/** Title line for a fresh session checkpoint document. */
export function checkpointTitle(): string {
  return "# Session checkpoint";
}

/**
 * Approximate token count. We have no real tokenizer in the plugin runtime, so
 * we use a deliberately conservative heuristic: max(words, chars/4). This
 * over-counts CJK (no spaces) via the chars/4 term and over-counts spaced text
 * via the word term, which is the safe direction for a *soft* budget.
 */
export function approxTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(words, Math.ceil(chars / 4));
}

/**
 * Truncate `text` so its approximate token count stays within `tokenBudget`.
 * Cuts on a character boundary derived from the budget and appends an ellipsis
 * marker. Returns the text unchanged if already within budget.
 */
export function truncateToBudget(text: string, tokenBudget: number): string {
  if (approxTokens(text) <= tokenBudget) return text;
  const marker = " …[截断]";
  // chars/4 is the dominant term once we're over budget; convert back.
  const charBudget = Math.max(0, tokenBudget * 4 - marker.length);
  return text.slice(0, charBudget).replace(/\s+$/, "") + marker;
}
