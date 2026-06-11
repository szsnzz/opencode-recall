import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  mergeFact,
  parseMemory,
  serializeMemory,
  type MergeOutcome,
} from "./storage/markdown.ts";
import { reconcile } from "./storage/reconcile.ts";
import {
  MEMORY_SECTIONS,
  memoryTitle,
  type MemorySection,
} from "./storage/templates.ts";
import type { MemoryStore } from "./store.ts";

const CANONICAL_HEADINGS = MEMORY_SECTIONS.map((s) => s.heading);

/** Read a file as UTF-8, returning "" if it doesn't exist. */
function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Atomic write: write to a temp sibling then rename over the target. Prevents
 * concurrent sessions from corrupting a shared project MEMORY.md.
 */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export interface RememberFactArgs {
  section: MemorySection;
  content: string;
  global?: boolean;
}

export interface RememberFactDeps {
  store: MemoryStore;
  /** Stable project id for the active session's repo. */
  projectId: string;
}

export interface RememberFactResult {
  path: string;
  scope: "project" | "global";
  outcome: MergeOutcome["action"];
}

/**
 * Core logic for the remember_fact tool: merge a durable fact into the project
 * (or global) MEMORY.md, write atomically, then refresh the FTS index so it's
 * immediately searchable.
 */
export async function rememberFact(
  args: RememberFactArgs,
  deps: RememberFactDeps,
): Promise<RememberFactResult> {
  const content = args.content?.trim();
  if (!content) throw new Error("content must not be empty");

  const isGlobal = args.global === true;
  const scope: "project" | "global" = isGlobal ? "global" : "project";
  const path = isGlobal
    ? deps.store.paths.globalMemory()
    : deps.store.paths.projectMemory(deps.projectId);

  const existing = readOrEmpty(path);
  const doc = parseMemory(existing);
  if (!doc.title) doc.title = memoryTitle(scope);

  const outcome = mergeFact(doc, args.section, content);

  if (outcome.action !== "duplicate") {
    const serialized = serializeMemory(doc, CANONICAL_HEADINGS);
    atomicWrite(path, serialized);
    // Make the new content searchable right away.
    await reconcile(deps.store.index(), deps.store.paths);
  }

  return { path, scope, outcome: outcome.action };
}
