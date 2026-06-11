import { describe, expect, test, afterEach } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandRoot, resolveConfig, loadRawConfig } from "../src/config.ts";

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

describe("loadRawConfig", () => {
  let root: string;
  const savedRoot = process.env["OPENCODE_MEMORY_ROOT"];
  const savedDisabled = process.env["OPENCODE_MEMORY_DISABLED"];

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    // restore env
    if (savedRoot === undefined) delete process.env["OPENCODE_MEMORY_ROOT"];
    else process.env["OPENCODE_MEMORY_ROOT"] = savedRoot;
    if (savedDisabled === undefined) delete process.env["OPENCODE_MEMORY_DISABLED"];
    else process.env["OPENCODE_MEMORY_DISABLED"] = savedDisabled;
  });

  test("returns empty config when no file exists", () => {
    root = mkdtempSync(join(tmpdir(), "mem-cfg-"));
    delete process.env["OPENCODE_MEMORY_ROOT"];
    delete process.env["OPENCODE_MEMORY_DISABLED"];
    expect(loadRawConfig(root)).toEqual({});
  });

  test("reads .opencode/memory.json", () => {
    root = mkdtempSync(join(tmpdir(), "mem-cfg-"));
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "memory.json"),
      JSON.stringify({ root: "/custom/mem", search: { limit: 5 } }),
    );
    delete process.env["OPENCODE_MEMORY_ROOT"];
    const raw = loadRawConfig(root);
    expect(raw.root).toBe("/custom/mem");
    expect(raw.search?.limit).toBe(5);
  });

  test("never throws on invalid JSON", () => {
    root = mkdtempSync(join(tmpdir(), "mem-cfg-"));
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(join(root, ".opencode", "memory.json"), "{ not valid json");
    expect(() => loadRawConfig(root)).not.toThrow();
    expect(loadRawConfig(root)).toEqual({});
  });

  test("env OPENCODE_MEMORY_ROOT overrides file", () => {
    root = mkdtempSync(join(tmpdir(), "mem-cfg-"));
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "memory.json"),
      JSON.stringify({ root: "/from/file" }),
    );
    process.env["OPENCODE_MEMORY_ROOT"] = "/from/env";
    expect(loadRawConfig(root).root).toBe("/from/env");
  });

  test("env OPENCODE_MEMORY_DISABLED=1 disables", () => {
    root = mkdtempSync(join(tmpdir(), "mem-cfg-"));
    delete process.env["OPENCODE_MEMORY_ROOT"];
    process.env["OPENCODE_MEMORY_DISABLED"] = "1";
    expect(loadRawConfig(root).enabled).toBe(false);
  });
});
