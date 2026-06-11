import { afterEach, beforeEach, describe, expect, test } from "./helpers/bun-test-shim.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../src/config.ts";
import { allDocs } from "../src/storage/index-db.ts";
import { MemoryStore } from "../src/store.ts";
import { appendNote, saveCheckpoint } from "../src/write.ts";

let root: string;
let store: MemoryStore;
const SID = "ses_write_01";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-sess-"));
  store = new MemoryStore(resolveConfig({ root }));
});

afterEach(() => {
  store.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("saveCheckpoint", () => {
  test("writes a checkpoint file and reports changed fields", async () => {
    const r = await saveCheckpoint(
      { intent: "ship M2", next_action: "run tests", files: ["a.ts"] },
      { store, sessionId: SID },
    );
    expect(r.path).toBe(store.paths.sessionCheckpoint(SID));
    expect([...r.changed].sort()).toEqual(
      (["files", "intent", "next_action"] as const).slice().sort(),
    );
    const content = readFileSync(r.path, "utf8");
    expect(content).toContain("# Session checkpoint");
    expect(content).toContain("ship M2");
    expect(content).toContain("- a.ts");
  });

  test("incrementally updates an existing checkpoint", async () => {
    await saveCheckpoint({ intent: "first" }, { store, sessionId: SID });
    await saveCheckpoint(
      { next_action: "second step", files: ["b.ts"] },
      { store, sessionId: SID },
    );
    const content = readFileSync(
      store.paths.sessionCheckpoint(SID),
      "utf8",
    );
    expect(content).toContain("first"); // preserved
    expect(content).toContain("second step"); // added
    expect(content).toContain("- b.ts");
  });

  test("no-op when nothing provided", async () => {
    const r = await saveCheckpoint({}, { store, sessionId: SID });
    expect(r.changed).toEqual([]);
  });

  test("checkpoint is indexed for search", async () => {
    await saveCheckpoint(
      { discovered: "the index aligns rowid with doc id" },
      { store, sessionId: SID },
    );
    const docs = allDocs(store.index());
    expect(docs.some((d) => d.type === "checkpoint")).toBe(true);
  });
});

describe("appendNote", () => {
  test("appends a timestamped bullet", async () => {
    const r = await appendNote("remember to run tsc", { store, sessionId: SID });
    expect(r.path).toBe(store.paths.sessionNotes(SID));
    const content = readFileSync(r.path, "utf8");
    expect(content).toContain("# Session notes");
    expect(content).toMatch(/- \[.+\] remember to run tsc/);
  });

  test("appends multiple notes in order", async () => {
    await appendNote("first note", { store, sessionId: SID });
    await appendNote("second note", { store, sessionId: SID });
    const content = readFileSync(store.paths.sessionNotes(SID), "utf8");
    expect(content.indexOf("first note")).toBeLessThan(
      content.indexOf("second note"),
    );
  });

  test("rejects empty content", async () => {
    await expect(
      appendNote("   ", { store, sessionId: SID }),
    ).rejects.toThrow();
  });

  test("note is indexed for search", async () => {
    await appendNote("a searchable observation", { store, sessionId: SID });
    const docs = allDocs(store.index());
    expect(docs.some((d) => d.type === "notes")).toBe(true);
  });
});
