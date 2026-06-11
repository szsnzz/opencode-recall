import { describe, expect, test } from "./helpers/bun-test-shim.ts";
import { resolve, sep } from "node:path";

import { MemoryPaths, projectIdFromPath } from "../src/storage/paths.ts";

const ROOT = resolve(sep === "\\" ? "C:\\tmp\\mem-root" : "/tmp/mem-root");

describe("projectIdFromPath", () => {
  test("is stable and 12 hex chars", () => {
    const a = projectIdFromPath("/home/u/proj");
    const b = projectIdFromPath("/home/u/proj");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test("differs for different paths", () => {
    expect(projectIdFromPath("/a")).not.toBe(projectIdFromPath("/b"));
  });
});

describe("MemoryPaths layout", () => {
  const p = new MemoryPaths(ROOT);

  test("global memory path", () => {
    expect(p.globalMemory()).toBe(resolve(ROOT, "global", "MEMORY.md"));
  });

  test("project memory path", () => {
    expect(p.projectMemory("abc123")).toBe(
      resolve(ROOT, "projects", "abc123", "MEMORY.md"),
    );
  });

  test("session checkpoint + notes paths", () => {
    expect(p.sessionCheckpoint("ses_1")).toBe(
      resolve(ROOT, "sessions", "ses_1", "checkpoint.md"),
    );
    expect(p.sessionNotes("ses_1")).toBe(
      resolve(ROOT, "sessions", "ses_1", "notes.md"),
    );
  });

  test("index db path", () => {
    expect(p.indexDb).toBe(resolve(ROOT, "index.db"));
  });
});

describe("MemoryPaths traversal guard", () => {
  const p = new MemoryPaths(ROOT);

  test("rejects path traversal in ids", () => {
    expect(() => p.projectMemory("../escape")).toThrow();
    expect(() => p.sessionCheckpoint("..")).toThrow();
    expect(() => p.sessionNotes("a/b")).toThrow();
    expect(() => p.projectDir("foo\\bar")).toThrow();
  });

  test("rejects empty / illegal ids", () => {
    expect(() => p.projectMemory("")).toThrow();
    expect(() => p.sessionDir("has space")).toThrow();
  });

  test("accepts safe ids", () => {
    expect(() => p.projectMemory("a1b2c3.d-e_f")).not.toThrow();
    expect(() => p.sessionCheckpoint("ses_abcDEF123")).not.toThrow();
  });
});

describe("MemoryPaths.classify", () => {
  const p = new MemoryPaths(ROOT);

  test("classifies global memory", () => {
    expect(p.classify(resolve(ROOT, "global", "MEMORY.md"))).toEqual({
      scope: "global",
      scopeId: "",
      type: "memory",
    });
  });

  test("classifies project memory", () => {
    expect(p.classify(resolve(ROOT, "projects", "pid", "MEMORY.md"))).toEqual({
      scope: "projects",
      scopeId: "pid",
      type: "memory",
    });
  });

  test("classifies session checkpoint and notes", () => {
    expect(p.classify(resolve(ROOT, "sessions", "sid", "checkpoint.md"))).toEqual(
      { scope: "sessions", scopeId: "sid", type: "checkpoint" },
    );
    expect(p.classify(resolve(ROOT, "sessions", "sid", "notes.md"))).toEqual({
      scope: "sessions",
      scopeId: "sid",
      type: "notes",
    });
  });

  test("returns undefined for unrelated paths", () => {
    expect(p.classify(resolve(ROOT, "random.md"))).toBeUndefined();
    expect(p.classify(resolve(ROOT, "projects", "pid", "other.md"))).toBeUndefined();
    expect(p.classify("/somewhere/else/MEMORY.md")).toBeUndefined();
  });
});
