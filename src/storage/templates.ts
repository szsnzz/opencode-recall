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
