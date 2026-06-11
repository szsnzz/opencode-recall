import { afterEach, beforeEach, describe, expect, test } from "./helpers/bun-test-shim.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CMD_CHECKPOINT,
  CMD_REMEMBER,
  handleRemember,
  injectCommands,
} from "../src/commands.ts";
import { resolveConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store.ts";

let root: string;
let store: MemoryStore;
const PID = "cmdproj0001";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-cmd-"));
  store = new MemoryStore(resolveConfig({ root }));
});

afterEach(() => {
  store.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("injectCommands", () => {
  test("adds /checkpoint and /remember to empty config", () => {
    const cfg: { command?: Record<string, unknown> } = {};
    injectCommands(cfg as Parameters<typeof injectCommands>[0]);
    expect(cfg.command).toBeDefined();
    expect(cfg.command![CMD_CHECKPOINT]).toBeDefined();
    expect(cfg.command![CMD_REMEMBER]).toBeDefined();
  });

  test("each command has a description and non-empty template", () => {
    const cfg: { command?: Record<string, { template?: string; description?: string }> } = {};
    injectCommands(cfg as Parameters<typeof injectCommands>[0]);
    for (const name of [CMD_CHECKPOINT, CMD_REMEMBER]) {
      expect(cfg.command![name]!.template!.length).toBeGreaterThan(0);
      expect(cfg.command![name]!.description!.length).toBeGreaterThan(0);
    }
  });

  test("does not override a user-defined command", () => {
    const cfg = {
      command: { [CMD_CHECKPOINT]: { template: "USER OWN", description: "mine" } },
    };
    injectCommands(cfg as unknown as Parameters<typeof injectCommands>[0]);
    expect(cfg.command[CMD_CHECKPOINT]!.template).toBe("USER OWN");
    // remember still injected
    expect((cfg.command as Record<string, unknown>)[CMD_REMEMBER]).toBeDefined();
  });
});

describe("handleRemember", () => {
  test("writes the fact to project durable_knowledge", async () => {
    const r = await handleRemember("the build uses bun test", {
      store,
      projectId: PID,
    });
    expect(r.handled).toBe(true);
    const content = readFileSync(store.paths.projectMemory(PID), "utf8");
    expect(content).toContain("## Discovered durable knowledge");
    expect(content).toContain("- the build uses bun test");
  });

  test("empty arguments returns usage hint, no file written", async () => {
    const r = await handleRemember("   ", { store, projectId: PID });
    expect(r.handled).toBe(true);
    expect(r.message).toContain("用法");
  });

  test("duplicate fact is reported as already existing", async () => {
    await handleRemember("a unique fact xyz", { store, projectId: PID });
    const r = await handleRemember("a unique fact xyz", { store, projectId: PID });
    expect(r.message).toContain("已存在");
  });
});
