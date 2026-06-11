import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";

import { allDocs, deleteDocByPath, upsertDoc } from "./index-db.ts";
import { MemoryPaths } from "./paths.ts";

export interface ReconcileResult {
  added: number;
  updated: number;
  removed: number;
  scanned: number;
}

function fingerprint(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Discover every memory markdown file currently on disk under the memory root.
 * Returns absolute paths. Missing directories are treated as empty.
 */
async function scanFiles(paths: MemoryPaths): Promise<string[]> {
  const found = new Set<string>();
  const patterns = [
    "global/MEMORY.md",
    "projects/*/MEMORY.md",
    "sessions/*/checkpoint.md",
    "sessions/*/notes.md",
  ];
  for (const pattern of patterns) {
    try {
      for await (const entry of glob(pattern, { cwd: paths.root })) {
        // node:fs glob yields paths relative to cwd; classify needs absolute.
        found.add(resolve(paths.root, entry));
      }
    } catch {
      // directory may not exist yet; ignore.
    }
  }
  return [...found];
}

/**
 * Incrementally sync the FTS index with on-disk files.
 *
 * - New / changed files (fingerprint mismatch) are re-indexed.
 * - Files that disappeared from disk are dropped from the index.
 *
 * Runs lazily before each search and after each write so freshly written
 * memories and hand-edited files both become searchable.
 */
export async function reconcile(
  db: Database,
  paths: MemoryPaths,
): Promise<ReconcileResult> {
  const onDisk = await scanFiles(paths);
  const onDiskSet = new Set(onDisk);

  const indexed = allDocs(db);
  const indexedByPath = new Map(indexed.map((d) => [d.path, d]));

  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const abs of onDisk) {
    const classified = paths.classify(abs);
    if (!classified) continue;

    let body: string;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      body = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    const fp = fingerprint(body);
    const existing = indexedByPath.get(abs);
    if (existing && existing.fingerprint === fp) {
      continue; // unchanged
    }

    upsertDoc(db, {
      path: abs,
      scope: classified.scope,
      scopeId: classified.scopeId,
      type: classified.type,
      fingerprint: fp,
      body,
    });
    if (existing) updated++;
    else added++;
  }

  // Drop index rows for files that no longer exist.
  for (const doc of indexed) {
    if (!onDiskSet.has(doc.path)) {
      deleteDocByPath(db, doc.path);
      removed++;
    }
  }

  return { added, updated, removed, scanned: onDisk.length };
}
