import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store.ts";
import { rememberFact } from "../src/write.ts";

let root: string;
let store: MemoryStore;
const PID = "testproj1234";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-write-"));
  store = new MemoryStore(resolveConfig({ root }));
});

afterEach(() => {
  store.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("rememberFact", () => {
  test("writes a new fact into project memory", async () => {
    const r = await rememberFact(
      { section: "rule", content: "always use bun" },
      { store, projectId: PID },
    );
    expect(r.outcome).toBe("added");
    expect(r.scope).toBe("project");
    const content = readFileSync(r.path, "utf8");
    expect(content).toContain("## Rules");
    expect(content).toContain("- always use bun");
    expect(content).toContain("# Project memory");
  });

  test("routes to global memory when global=true", async () => {
    const r = await rememberFact(
      { section: "rule", content: "prefer tabs", global: true },
      { store, projectId: PID },
    );
    expect(r.scope).toBe("global");
    expect(r.path).toBe(store.paths.globalMemory());
    expect(readFileSync(r.path, "utf8")).toContain("# Global memory");
  });

  test("deduplicates identical facts", async () => {
    await rememberFact(
      { section: "gotcha", content: "watch the GBK console" },
      { store, projectId: PID },
    );
    const r2 = await rememberFact(
      { section: "gotcha", content: "watch the GBK console" },
      { store, projectId: PID },
    );
    expect(r2.outcome).toBe("duplicate");
    const content = readFileSync(r2.path, "utf8");
    const occurrences = content.split("watch the GBK console").length - 1;
    expect(occurrences).toBe(1);
  });

  test("merges different sections separately", async () => {
    await rememberFact(
      { section: "rule", content: "rule one" },
      { store, projectId: PID },
    );
    const r = await rememberFact(
      { section: "architecture_decision", content: "use sqlite fts5" },
      { store, projectId: PID },
    );
    const content = readFileSync(r.path, "utf8");
    expect(content).toContain("## Rules");
    expect(content).toContain("## Architecture decisions");
    expect(content).toContain("- rule one");
    expect(content).toContain("- use sqlite fts5");
  });

  test("rejects empty content", async () => {
    await expect(
      rememberFact({ section: "rule", content: "   " }, { store, projectId: PID }),
    ).rejects.toThrow();
  });

  test("written fact is immediately searchable (index updated)", async () => {
    await rememberFact(
      { section: "durable_knowledge", content: "the parser lives in fts-query" },
      { store, projectId: PID },
    );
    // reconcile ran inside rememberFact; the doc should be in the index.
    const { allDocs } = await import("../src/storage/index-db.ts");
    expect(allDocs(store.index()).length).toBe(1);
  });
});
