import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { createOpencodeClient } from "@opencode-ai/sdk";

import type { MemoryStore } from "./store.ts";

type Client = ReturnType<typeof createOpencodeClient>;

export interface ConsolidateDeps {
  store: MemoryStore;
  projectId: string;
  sessionId: string;
  client: Client;
}

/** Read a file as UTF-8, returning "" if it doesn't exist. */
function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Collect all memory files relevant to this project for dream/distill context. */
function gatherMemoryContent(store: MemoryStore, projectId: string): string {
  const parts: string[] = [];

  const globalMem = store.paths.globalMemory();
  const globalContent = readOrEmpty(globalMem);
  if (globalContent) parts.push(`## Global memory\n\n${globalContent}`);

  const projectMem = store.paths.projectMemory(projectId);
  const projectContent = readOrEmpty(projectMem);
  if (projectContent) parts.push(`## Project memory\n\n${projectContent}`);

  // Collect recent session checkpoints (up to 20).
  const sessionsDir = store.paths.sessionsDir;
  if (existsSync(sessionsDir)) {
    const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .slice(-20);

    for (const sid of sessionDirs) {
      const cpPath = store.paths.sessionCheckpoint(sid);
      const cp = readOrEmpty(cpPath);
      if (cp) parts.push(`## Session checkpoint (${sid})\n\n${cp}`);
    }
  }

  return parts.join("\n\n---\n\n");
}

const DREAM_PROMPT = `你是一个记忆整理助手。以下是项目的全部记忆文件内容：

<memory>
{MEMORY}
</memory>

请执行记忆收敛：
1. 用 remember_fact 工具把分散在各 session checkpoint 的持久知识合并写入项目记忆（去重，合并相似条目，删除已过时的）
2. 把相对日期改为绝对日期（今天是 {DATE}）
3. 确认提到的文件路径/函数名是否仍然存在（用 grep 验证），删除已失效的引用
4. 全局性的偏好/规则用 remember_fact(global=true) 写入全局记忆

完成后简短说明做了哪些合并、晋升了哪些条目。没有值得合并的就直接说"无需收敛"。`;

const DISTILL_PROMPT = `你是一个工作流提炼助手。以下是项目的全部记忆文件内容：

<memory>
{MEMORY}
</memory>

请回顾历史，识别重复出现的手工工作流或操作模式。对于高置信度的重复模式，建议将其沉淀为 opencode 的 skill 或 command（描述名称、触发时机、模板内容）。

如果没有识别到值得沉淀的重复模式，直接回答"暂无值得提炼的工作流"。不要强行捏造建议。`;

async function sendPrompt(
  client: Client,
  sessionId: string,
  text: string,
): Promise<string> {
  const res = await client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text }],
    },
  });
  // Extract text from response parts.
  const parts = res.data?.parts ?? [];
  return parts
    .filter((p: { type: string }) => p.type === "text")
    .map((p: { type: string; text?: string }) => p.text ?? "")
    .join("");
}

/** Check if the interval since last run has elapsed. Returns true if should run. */
function shouldRun(lastRunPath: string, intervalDays: number): boolean {
  if (intervalDays <= 0) return true;
  try {
    const ts = parseInt(readFileSync(lastRunPath, "utf8").trim(), 10);
    const elapsed = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    return elapsed >= intervalDays;
  } catch {
    return true;
  }
}

function writeTimestamp(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(Date.now()), "utf8");
}

export interface DreamResult {
  skipped: boolean;
  message: string;
}

export async function runDream(deps: ConsolidateDeps): Promise<DreamResult> {
  const { store, projectId, sessionId, client } = deps;
  const intervalDays = store.config.dream.intervalDays;

  const lastRunPath = `${store.paths.projectDir(projectId)}/.dream_last_run`;

  if (!shouldRun(lastRunPath, intervalDays)) {
    const days = intervalDays;
    return {
      skipped: true,
      message: `距上次 /dream 运行不足 ${days} 天，跳过。如需强制运行请修改 intervalDays: 0。`,
    };
  }

  const memory = gatherMemoryContent(store, projectId);
  if (!memory.trim()) {
    return { skipped: false, message: "记忆库为空，无需收敛。" };
  }

  const today = new Date().toISOString().slice(0, 10);
  const prompt = DREAM_PROMPT.replace("{MEMORY}", memory).replace("{DATE}", today);

  const response = await sendPrompt(client, sessionId, prompt);
  writeTimestamp(lastRunPath);

  return { skipped: false, message: response || "dream 完成。" };
}

export interface DistillResult {
  skipped: boolean;
  message: string;
}

export async function runDistill(deps: ConsolidateDeps): Promise<DistillResult> {
  const { store, projectId, sessionId, client } = deps;
  const intervalDays = store.config.distill.intervalDays;

  const lastRunPath = `${store.paths.projectDir(projectId)}/.distill_last_run`;

  if (!shouldRun(lastRunPath, intervalDays)) {
    return {
      skipped: true,
      message: `距上次 /distill 运行不足 ${intervalDays} 天，跳过。`,
    };
  }

  const memory = gatherMemoryContent(store, projectId);
  if (!memory.trim()) {
    return { skipped: false, message: "记忆库为空，无可提炼内容。" };
  }

  const prompt = DISTILL_PROMPT.replace("{MEMORY}", memory);

  const response = await sendPrompt(client, sessionId, prompt);
  writeTimestamp(lastRunPath);

  return { skipped: false, message: response || "distill 完成。" };
}
