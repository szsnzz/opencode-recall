import type { Database } from "bun:sqlite";

import type { MemoryConfig } from "./config.ts";
import { openIndex } from "./storage/index-db.ts";
import { MemoryPaths } from "./storage/paths.ts";

/**
 * Shared runtime state for the memory plugin: the resolved config, the path
 * resolver, and the lazily-opened SQLite index. One store per plugin instance.
 */
export class MemoryStore {
  readonly config: MemoryConfig;
  readonly paths: MemoryPaths;
  private db: Database | undefined;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.paths = new MemoryPaths(config.root);
  }

  /** Open the index on first use. */
  index(): Database {
    if (!this.db) {
      this.db = openIndex(this.paths.indexDb);
    }
    return this.db;
  }

  dispose(): void {
    this.db?.close();
    this.db = undefined;
  }
}
