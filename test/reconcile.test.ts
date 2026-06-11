import { afterEach, beforeEach, describe, expect, test } from "./helpers/bun-test-shim.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openIndex, allDocs } from "../src/storage/index-db.ts";
import { MemoryPaths } from "../src/storage/paths.ts";
import { reconcile } from "../src/storage/reconcile.ts";

let root: string;
let paths: MemoryPaths;
let db: ReturnType<typeof openIndex>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-recon-"));
  paths = new MemoryPaths(root);
  db = openIndex(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function writeProjectMemory(pid: string, body: string): string {
  const p = paths.projectMemory(pid);
  mkdirSync(resolve(root, "projects", pid), { recursive: true });
  writeFileSync(p, body, "utf8");
  return p;
}

describe("reconcile", () => {
  test("indexes new files", async () => {
    writeProjectMemory("pid1", "# Project memory\n\n## Rules\n\n- use bun\n");
    const r = await reconcile(db, paths);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.removed).toBe(0);
    expect(allDocs(db).length).toBe(1);
  });

  test("skips unchanged files (fingerprint match)", async () => {
    writeProjectMemory("pid1", "# Project memory\n\n## Rules\n\n- use bun\n");
    await reconcile(db, paths);
    const second = await reconcile(db, paths);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
  });

  test("re-indexes changed files", async () => {
    writeProjectMemory("pid1", "# Project memory\n\n## Rules\n\n- one\n");
    await reconcile(db, paths);
    writeProjectMemory("pid1", "# Project memory\n\n## Rules\n\n- one\n- two\n");
    const r = await reconcile(db, paths);
    expect(r.updated).toBe(1);
    expect(r.added).toBe(0);
  });

  test("removes deleted files from index", async () => {
    const p = writeProjectMemory("pid1", "# Project memory\n\n## Rules\n\n- x\n");
    await reconcile(db, paths);
    rmSync(p);
    const r = await reconcile(db, paths);
    expect(r.removed).toBe(1);
    expect(allDocs(db).length).toBe(0);
  });

  test("handles missing memory root gracefully", async () => {
    const empty = new MemoryPaths(join(root, "does-not-exist"));
    const r = await reconcile(db, empty);
    expect(r.scanned).toBe(0);
    expect(r.added).toBe(0);
  });

  test("indexes all three layers", async () => {
    writeProjectMemory("pid1", "# Project memory\n\n## Rules\n\n- proj\n");
    mkdirSync(resolve(root, "global"), { recursive: true });
    writeFileSync(paths.globalMemory(), "# Global memory\n\n## Rules\n\n- glob\n");
    mkdirSync(resolve(root, "sessions", "ses1"), { recursive: true });
    writeFileSync(paths.sessionCheckpoint("ses1"), "# Checkpoint\n\n- ckpt\n");
    const r = await reconcile(db, paths);
    expect(r.added).toBe(3);
  });
});
