import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "./sqlite.ts";
import { segment } from "./segment.ts";

/**
 * Row in the memory_doc table. Mirrors the schema in DESIGN.md §3.4.
 */
export interface MemoryDocRow {
  id: number;
  path: string;
  scope: string;
  scope_id: string;
  type: string;
  fingerprint: string;
  indexed_at: number;
}

/**
 * Opens (and lazily migrates) the plugin's private SQLite index. This database
 * is owned entirely by the plugin and never touches opencode's own storage.
 *
 * memory_fts.rowid is kept aligned with memory_doc.id so we can join the FTS
 * virtual table back to document metadata.
 */
export function openIndex(dbPath: string): Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_doc (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT UNIQUE NOT NULL,
      scope       TEXT NOT NULL,
      scope_id    TEXT NOT NULL DEFAULT '',
      type        TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      indexed_at  INTEGER NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS memory_doc_scope_idx ON memory_doc(scope, scope_id);`,
  );
  // Tokenizer: `unicode61 remove_diacritics 1` (same family as MiMo Code's
  // migration 20260521010000_memory_fts_v6). We deliberately do NOT use
  // `porter`, keeping behavior aligned with MiMo for portability.
  //
  // Two columns:
  //   - body   : the original, human-readable text. Used for snippet() output.
  //   - search : the CJK-segmented text (see segment.ts). unicode61 treats a
  //              run of CJK as ONE token, so substring search is impossible on
  //              raw text. We index bigram-segmented text here and MATCH only
  //              this column ({search} : (...)), which restores CJK substring
  //              recall while leaving english/identifier search untouched.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      body,
      search,
      tokenize = 'unicode61 remove_diacritics 1'
    );
  `);
}

/**
 * Insert or replace a document's metadata + FTS body atomically, keeping
 * memory_doc.id and memory_fts.rowid aligned.
 */
export function upsertDoc(
  db: Database,
  doc: {
    path: string;
    scope: string;
    scopeId: string;
    type: string;
    fingerprint: string;
    body: string;
  },
): void {
  const tx = db.transaction(() => {
    const existing = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM memory_doc WHERE path = ?",
      )
      .get(doc.path);

    const now = Date.now();
    const search = segment(doc.body);
    if (existing) {
      db.query(
        `UPDATE memory_doc
           SET scope = ?, scope_id = ?, type = ?, fingerprint = ?, indexed_at = ?
         WHERE id = ?`,
      ).run(doc.scope, doc.scopeId, doc.type, doc.fingerprint, now, existing.id);
      db.query("DELETE FROM memory_fts WHERE rowid = ?").run(existing.id);
      db.query("INSERT INTO memory_fts(rowid, body, search) VALUES (?, ?, ?)").run(
        existing.id,
        doc.body,
        search,
      );
    } else {
      const info = db
        .query(
          `INSERT INTO memory_doc(path, scope, scope_id, type, fingerprint, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(doc.path, doc.scope, doc.scopeId, doc.type, doc.fingerprint, now);
      const id = Number(info.lastInsertRowid);
      db.query("INSERT INTO memory_fts(rowid, body, search) VALUES (?, ?, ?)").run(
        id,
        doc.body,
        search,
      );
    }
  });
  tx();
}

/** Remove a document (and its FTS row) by path. No-op if absent. */
export function deleteDocByPath(db: Database, path: string): void {
  const tx = db.transaction(() => {
    const existing = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM memory_doc WHERE path = ?",
      )
      .get(path);
    if (!existing) return;
    db.query("DELETE FROM memory_fts WHERE rowid = ?").run(existing.id);
    db.query("DELETE FROM memory_doc WHERE id = ?").run(existing.id);
  });
  tx();
}

/** All indexed document rows (used by reconcile to detect deletions). */
export function allDocs(db: Database): MemoryDocRow[] {
  return db.query<MemoryDocRow, []>("SELECT * FROM memory_doc").all();
}
