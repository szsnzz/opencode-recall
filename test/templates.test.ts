import { describe, expect, test } from "./helpers/bun-test-shim.ts";

import {
  approxTokens,
  truncateToBudget,
  CHECKPOINT_SECTIONS,
  checkpointDef,
} from "../src/storage/templates.ts";

describe("approxTokens", () => {
  test("empty is zero", () => {
    expect(approxTokens("")).toBe(0);
  });

  test("scales with length", () => {
    const small = approxTokens("hello world");
    const big = approxTokens("hello world ".repeat(100));
    expect(big).toBeGreaterThan(small);
  });

  test("counts CJK via chars/4", () => {
    // 8 CJK chars, no spaces -> ceil(8/4) = 2 at least.
    expect(approxTokens("记忆检索系统设计实现")).toBeGreaterThanOrEqual(2);
  });
});

describe("truncateToBudget", () => {
  test("leaves short text unchanged", () => {
    expect(truncateToBudget("short", 500)).toBe("short");
  });

  test("truncates long text and appends marker", () => {
    const long = "word ".repeat(5000);
    const out = truncateToBudget(long, 100);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("[截断]");
    expect(approxTokens(out)).toBeLessThanOrEqual(120); // within ~budget + marker
  });
});

describe("CHECKPOINT_SECTIONS", () => {
  test("has the eight design sections in order", () => {
    expect(CHECKPOINT_SECTIONS.map((s) => s.key)).toEqual([
      "intent",
      "next_action",
      "current_work",
      "files",
      "discovered",
      "errors_fixes",
      "decisions",
      "open_questions",
    ]);
  });

  test("files is the only list section", () => {
    const lists = CHECKPOINT_SECTIONS.filter((s) => s.list);
    expect(lists.map((s) => s.key)).toEqual(["files"]);
  });

  test("every section has a positive token budget", () => {
    for (const s of CHECKPOINT_SECTIONS) {
      expect(checkpointDef(s.key).tokenBudget).toBeGreaterThan(0);
    }
  });
});
