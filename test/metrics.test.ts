import { describe, expect, test, beforeEach, afterEach } from "./helpers/bun-test-shim.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store.ts";
import { bump, readAll, formatStats, type MetricRow } from "../src/metrics.ts";

let root: string;
let store: MemoryStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-metrics-"));
  store = new MemoryStore(resolveConfig({ root }));
});

afterEach(() => {
  store.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("bump", () => {
  test("inserts a new counter at 1", () => {
    bump(store, "search.count");
    const rows = readAll(store.index());
    expect(rows.find((r) => r.key === "search.count")?.count).toBe(1);
  });

  test("accumulates on repeated bumps (ON CONFLICT)", () => {
    bump(store, "remember.added");
    bump(store, "remember.added");
    bump(store, "remember.added", 3);
    const rows = readAll(store.index());
    expect(rows.find((r) => r.key === "remember.added")?.count).toBe(5);
  });

  test("tracks distinct keys independently", () => {
    bump(store, "dream.run");
    bump(store, "dream.skip");
    bump(store, "dream.skip");
    const rows = readAll(store.index());
    expect(rows.find((r) => r.key === "dream.run")?.count).toBe(1);
    expect(rows.find((r) => r.key === "dream.skip")?.count).toBe(2);
  });

  test("no-op when metrics disabled", () => {
    const disabled = new MemoryStore(resolveConfig({ root, metrics: { enabled: false } }));
    bump(disabled, "search.count");
    expect(readAll(disabled.index()).length).toBe(0);
    disabled.dispose();
  });

  test("never throws", () => {
    // Calling with an odd key must not throw.
    expect(() => bump(store, "weird.custom.key")).not.toThrow();
  });
});

describe("formatStats", () => {
  test("reports empty state when no rows", () => {
    expect(formatStats([])).toContain("暂无统计数据");
  });

  test("computes zero-hit percentage", () => {
    const rows: MetricRow[] = [
      { key: "search.count", count: 4, updated_at: 1 },
      { key: "search.zero_hits", count: 1, updated_at: 1 },
    ];
    const out = formatStats(rows);
    expect(out).toContain("4 次");
    expect(out).toContain("25% 零命中");
  });
});
