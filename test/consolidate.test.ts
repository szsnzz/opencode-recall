import { afterEach, beforeEach, describe, expect, test } from "./helpers/bun-test-shim.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store.ts";
import { runDream, runDistill } from "../src/consolidate.ts";

let root: string;
let store: MemoryStore;
const PID = "testproj1234";
const SID = "session-abc";

interface MockClient {
  session: {
    prompt: (opts: { path: { id: string }; body: { parts: { type: string; text: string }[] } }) => Promise<{ data: { parts: { type: string; text: string }[] } }>;
  };
  getLastPrompt: () => string;
}

function makeClient(responseText: string = "done"): MockClient {
  let lastPrompt = "";
  return {
    session: {
      prompt: async (opts) => {
        lastPrompt = opts.body.parts.map((p) => p.text).join("");
        return { data: { parts: [{ type: "text", text: responseText }] } };
      },
    },
    getLastPrompt: () => lastPrompt,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-consolidate-"));
  store = new MemoryStore(resolveConfig({ root }));
});

afterEach(() => {
  store.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("runDream", () => {
  test("returns empty-memory message when no memory files exist", async () => {
    const client = makeClient();
    const result = await runDream({ store, projectId: PID, sessionId: SID, client: client as never });
    expect(result.skipped).toBe(false);
    expect(result.message).toContain("为空");
  });

  test("sends memory content to LLM when files exist", async () => {
    // Write a project memory file.
    const memPath = store.paths.projectMemory(PID);
    mkdirSync(join(root, "projects", PID), { recursive: true });
    writeFileSync(memPath, "# Project memory\n\n## Rules\n\n- use tabs\n");

    const client = makeClient("merged ok");
    const result = await runDream({ store, projectId: PID, sessionId: SID, client: client as never });

    expect(result.skipped).toBe(false);
    expect(result.message).toBe("merged ok");
    expect(client.getLastPrompt()).toContain("use tabs");
  });

  test("skips when interval has not elapsed", async () => {
    // Write a project memory so it doesn't bail on empty.
    const memPath = store.paths.projectMemory(PID);
    mkdirSync(join(root, "projects", PID), { recursive: true });
    writeFileSync(memPath, "# Project memory\n\n## Rules\n\n- x\n");

    const client = makeClient("ok");
    // First run — writes timestamp.
    await runDream({ store, projectId: PID, sessionId: SID, client: client as never });

    // Second run with intervalDays=7 — should skip.
    const result = await runDream({ store, projectId: PID, sessionId: SID, client: client as never });
    expect(result.skipped).toBe(true);
    expect(result.message).toContain("不足");
  });

  test("does not skip when intervalDays=0", async () => {
    const memPath = store.paths.projectMemory(PID);
    mkdirSync(join(root, "projects", PID), { recursive: true });
    writeFileSync(memPath, "# Project memory\n\n## Rules\n\n- x\n");

    const storeZero = new MemoryStore(resolveConfig({ root, dream: { intervalDays: 0 } }));
    const client = makeClient("ok");

    await runDream({ store: storeZero, projectId: PID, sessionId: SID, client: client as never });
    const result = await runDream({ store: storeZero, projectId: PID, sessionId: SID, client: client as never });
    expect(result.skipped).toBe(false);
    storeZero.dispose();
  });
});

describe("runDistill", () => {
  test("returns empty-memory message when no memory files exist", async () => {
    const client = makeClient();
    const result = await runDistill({ store, projectId: PID, sessionId: SID, client: client as never });
    expect(result.skipped).toBe(false);
    expect(result.message).toContain("为空");
  });

  test("sends memory content to LLM and returns response", async () => {
    const memPath = store.paths.projectMemory(PID);
    mkdirSync(join(root, "projects", PID), { recursive: true });
    writeFileSync(memPath, "# Project memory\n\n## Patterns\n\n- run tests before commit\n");

    const client = makeClient("暂无值得提炼的工作流");
    const result = await runDistill({ store, projectId: PID, sessionId: SID, client: client as never });

    expect(result.skipped).toBe(false);
    expect(result.message).toContain("暂无");
    expect(client.getLastPrompt()).toContain("run tests");
  });
});
