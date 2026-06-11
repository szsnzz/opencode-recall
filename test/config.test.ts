import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { expandRoot, resolveConfig } from "../src/config.ts";

describe("expandRoot", () => {
  test("expands leading ~/", () => {
    const out = expandRoot("~/foo/bar");
    expect(out.startsWith(homedir())).toBe(true);
    expect(isAbsolute(out)).toBe(true);
  });

  test("bare ~ becomes home", () => {
    expect(expandRoot("~")).toBe(homedir());
  });

  test("absolute-resolves a relative path", () => {
    expect(isAbsolute(expandRoot("./rel"))).toBe(true);
  });
});

describe("resolveConfig", () => {
  test("applies defaults when raw is undefined", () => {
    const c = resolveConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.search.scoreFloor).toBe(0.15);
    expect(c.search.limit).toBe(10);
    expect(c.dream.intervalDays).toBe(7);
    expect(c.distill.intervalDays).toBe(30);
    expect(isAbsolute(c.root)).toBe(true);
  });

  test("enabled is false only when explicitly false", () => {
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveConfig({}).enabled).toBe(true);
  });

  test("clamps out-of-range values", () => {
    const c = resolveConfig({
      search: { scoreFloor: 5, limit: 9999 },
      dream: { intervalDays: -3 },
    });
    expect(c.search.scoreFloor).toBe(1);
    expect(c.search.limit).toBe(100);
    expect(c.dream.intervalDays).toBe(0);
  });

  test("ignores non-numeric junk and falls back", () => {
    const c = resolveConfig({
      // @ts-expect-error testing runtime coercion
      search: { scoreFloor: "high", limit: null },
    });
    expect(c.search.scoreFloor).toBe(0.15);
    expect(c.search.limit).toBe(10);
  });
});
