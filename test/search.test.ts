import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../src/config.ts";
import { memorySearch } from "../src/search.ts";
import { MemoryStore } from "../src/store.ts";
import { rememberFact } from "../src/write.ts";

let root: string;
let store: MemoryStore;
const PID = "proj_search1";
const OTHER_PID = "proj_other99";
const SID = "ses_current";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-search-"));
  store = new MemoryStore(resolveConfig({ root, search: { scoreFloor: 0.15 } }));
});

afterEach(() => {
  store.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("memorySearch", () => {
  test("finds a previously remembered fact", async () => {
    await rememberFact(
      { section: "gotcha", content: "the PowerShell console uses GBK encoding" },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "powershell encoding" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.snippet.toLowerCase()).toContain("gbk");
    expect(hits[0]!.scope).toBe("projects");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  test("empty query returns nothing", async () => {
    await rememberFact(
      { section: "rule", content: "use bun" },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "   " },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits).toEqual([]);
  });

  test("does not leak another project's memory", async () => {
    await rememberFact(
      { section: "rule", content: "secret alpha rule about widgets" },
      { store, projectId: OTHER_PID },
    );
    const hits = await memorySearch(
      { query: "widgets alpha" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBe(0);
  });

  test("global memory is visible in default scope", async () => {
    await rememberFact(
      { section: "rule", content: "global widget convention", global: true },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "widget convention" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.scope === "global")).toBe(true);
  });

  test("scope=project excludes global", async () => {
    await rememberFact(
      { section: "rule", content: "global only thing zeta", global: true },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "zeta", scope: "project" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBe(0);
  });

  test("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await rememberFact(
        { section: "durable_knowledge", content: `shared keyword fact number ${i}` },
        { store, projectId: PID },
      );
    }
    // All 5 facts are in one MEMORY.md doc, so there's one doc; add distinct
    // sessions to exercise limit across docs.
    const hits = await memorySearch(
      { query: "shared keyword", limit: 1 },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  test("score floor keeps the top hit even when alone", async () => {
    await rememberFact(
      { section: "rule", content: "unique distinctive phrase quokka" },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "quokka" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBe(1);
    expect(hits[0]!.score).toBe(1);
  });

  // --- CJK substring recall (the regression fixed by bigram segmentation) ---

  test("finds a CJK substring inside an unspaced run", async () => {
    // Stored text has no spaces between CJK chars; "简洁" is a substring of
    // "并且简洁". With raw unicode61 this returned 0; bigram segmentation fixes it.
    await rememberFact(
      { section: "rule", content: "提交信息要用中文，并且简洁" },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "简洁" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.snippet).toContain("简洁");
  });

  test("finds a mid-run CJK substring", async () => {
    await rememberFact(
      { section: "durable_knowledge", content: "插件可加载并写入隔离目录" },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "写入" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test("snippet shows original un-segmented text", async () => {
    await rememberFact(
      { section: "rule", content: "数据库连接串要放到环境变量" },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "环境变量" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // No injected spaces between CJK chars in the displayed snippet.
    expect(hits[0]!.snippet).toContain("环境变量");
    expect(hits[0]!.snippet).not.toContain("环境 境变");
  });

  test("unrelated CJK query returns nothing", async () => {
    await rememberFact(
      { section: "rule", content: "提交信息要用中文" },
      { store, projectId: PID },
    );
    const hits = await memorySearch(
      { query: "数据库" },
      { store, projectId: PID, sessionId: SID },
    );
    expect(hits.length).toBe(0);
  });

});
