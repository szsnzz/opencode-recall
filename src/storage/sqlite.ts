/**
 * Tiny SQLite wrapper over Node's built-in `node:sqlite` (Node 22.5+/stable in
 * 24+), exposing a `bun:sqlite`-style API so the rest of the codebase reads the
 * same regardless of runtime.
 *
 * WHY: opencode's desktop app loads plugins under a Node.js runtime (verified
 * v24.15.0), NOT Bun — so `bun:sqlite` is unavailable and importing it makes
 * the whole plugin fail to load. `node:sqlite` ships FTS5 and covers everything
 * we need. See DESIGN.md §8 (runtime portability).
 *
 * The surface we emulate:
 *   db.query<Row, Params>(sql).get(...params) -> Row | undefined
 *   db.query<Row, Params>(sql).all(...params) -> Row[]
 *   db.query(sql).run(...params)              -> { changes, lastInsertRowid }
 *   db.exec(sql)                              -> void
 *   db.transaction(fn)                        -> () => ReturnType<fn>
 *   db.close()                                -> void
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Params = (string | number | bigint | null | Uint8Array)[];

class Stmt<Row> {
  private readonly stmt: StatementSync;

  constructor(stmt: StatementSync) {
    this.stmt = stmt;
  }

  get(...params: Params): Row | undefined {
    return this.stmt.get(...params) as Row | undefined;
  }

  all(...params: Params): Row[] {
    return this.stmt.all(...params) as Row[];
  }

  run(...params: Params): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const r = this.stmt.run(...params);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  /** Prepare a statement. Generics mirror bun:sqlite's query<Row, Params>(). */
  query<Row = unknown, _Params = Params>(sql: string): Stmt<Row> {
    return new Stmt<Row>(this.db.prepare(sql));
  }

  /** Execute raw SQL (no params, possibly multiple statements). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Wrap fn in a transaction. Returns a callable (like bun:sqlite) that runs
   * the body inside BEGIN/COMMIT, rolling back on throw.
   */
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec("BEGIN");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore rollback failure; surface the original error
        }
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
