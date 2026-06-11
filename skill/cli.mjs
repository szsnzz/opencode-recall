#!/usr/bin/env node
// opencode-recall CLI — the skill-driven entry point.
//
// This replaces the opencode *plugin* surface (which was blocked by a desktop
// dependency-installer bug, see DESIGN.md). The backend logic is identical and
// imported from ./lib (compiled from ../src). The LLM, driven by SKILL.md,
// invokes these subcommands instead of calling plugin tools.
//
// Why a CLI: skills run plain files via the shell and never go through
// opencode's npm plugin installer, so they sidestep the @opencode-ai/plugin@local
// failure entirely. Runtime deps are zero (only node:sqlite + node builtins).
//
// Usage:
//   node cli.mjs remember  --project <dir> --section <s> --content <text> [--global]
//   node cli.mjs checkpoint --project <dir> --session <id> [--intent ... --next-action ... ...]
//   node cli.mjs note      --project <dir> --session <id> --content <text>
//   node cli.mjs search    --project <dir> --session <id> --query <q> [--scope all|project|session|global] [--limit N]
//   node cli.mjs stats     --project <dir>
//   node cli.mjs dump      --project <dir> [--mode dream|distill]   (prints memory for LLM-side consolidation)
//
// All commands print human-readable text to stdout. Errors go to stderr + exit 1.

import { resolve } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";

import { loadRawConfig, resolveConfig } from "./lib/config.js";
import { MemoryStore } from "./lib/store.js";
import { projectIdFromPath } from "./lib/storage/paths.js";
import { rememberFact, saveCheckpoint, appendNote } from "./lib/write.js";
import { memorySearch } from "./lib/search.js";
import { bump, readAll, formatStats } from "./lib/metrics.js";

const SECTION_VALUES = [
  "rule",
  "architecture_decision",
  "durable_knowledge",
  "pattern",
  "gotcha",
];
const SCOPE_VALUES = ["all", "project", "session", "global"];

/** Minimal flag parser: --key value, and bare --flag booleans. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`错误：${msg}\n`);
  process.exit(1);
}

/** Resolve project root from --project (defaults to cwd) and build store + ids. */
function setup(args) {
  const projectRoot = resolve(
    typeof args.project === "string" && args.project.trim() ? args.project : process.cwd(),
  );
  const config = resolveConfig(loadRawConfig(projectRoot), projectRoot);
  if (!config.enabled) fail("记忆功能已被配置禁用（enabled:false）");
  const store = new MemoryStore(config);
  const projectId = projectIdFromPath(projectRoot);
  return { projectRoot, config, store, projectId };
}

/** Default session id: a date bucket, so a day's notes/checkpoints group together. */
function defaultSession() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `cli-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function sessionFrom(args) {
  const s = typeof args.session === "string" && args.session.trim() ? args.session.trim() : defaultSession();
  return s;
}

async function cmdRemember(args) {
  const { store, projectId } = setup(args);
  const section = String(args.section ?? "");
  if (!SECTION_VALUES.includes(section)) {
    fail(`--section 必须是其一：${SECTION_VALUES.join(" / ")}`);
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) fail("--content 不能为空");
  try {
    const result = await rememberFact(
      { section, content, global: args.global === true },
      { store, projectId },
    );
    bump(store, `remember.${result.outcome}`);
    if (result.scope === "global") bump(store, "remember.global");
    const verb =
      result.outcome === "added"
        ? "已记录"
        : result.outcome === "updated"
          ? "已更新已有条目"
          : "已存在，跳过";
    process.stdout.write(`${verb}（${result.scope} 记忆，段=${section}）\n${result.path}\n`);
  } finally {
    store.dispose();
  }
}

async function cmdCheckpoint(args) {
  const { store } = setup(args);
  const sessionId = sessionFrom(args);
  const update = {
    intent: args.intent,
    next_action: args["next-action"],
    current_work: args["current-work"],
    files:
      typeof args.files === "string"
        ? args.files.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    discovered: args.discovered,
    errors_fixes: args["errors-fixes"],
    decisions: args.decisions,
    open_questions: args["open-questions"],
  };
  // Drop boolean-true (flag without value) noise.
  for (const k of Object.keys(update)) {
    if (update[k] === true) update[k] = undefined;
  }
  try {
    const result = await saveCheckpoint(update, { store, sessionId });
    if (result.changed.length === 0) {
      process.stdout.write("没有提供任何内容，检查点未改动。\n");
      return;
    }
    bump(store, "checkpoint.saved");
    process.stdout.write(
      `已存档检查点（会话 ${sessionId}；更新段：${result.changed.join(", ")}）\n${result.path}\n`,
    );
  } finally {
    store.dispose();
  }
}

async function cmdNote(args) {
  const { store } = setup(args);
  const sessionId = sessionFrom(args);
  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) fail("--content 不能为空");
  try {
    const result = await appendNote(content, { store, sessionId });
    bump(store, "note.added");
    process.stdout.write(`已记到会话草稿本（${sessionId}）\n${result.path}\n`);
  } finally {
    store.dispose();
  }
}

async function cmdSearch(args) {
  const { store, projectId } = setup(args);
  const sessionId = sessionFrom(args);
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) fail("--query 不能为空");
  const scope =
    typeof args.scope === "string" && SCOPE_VALUES.includes(args.scope) ? args.scope : "all";
  const limit = args.limit !== undefined ? Number(args.limit) : undefined;
  try {
    const hits = await memorySearch({ query, scope, limit }, { store, projectId, sessionId });
    bump(store, "search.count");
    if (hits.length === 0) {
      bump(store, "search.zero_hits");
      process.stdout.write("没有找到相关记忆。\n");
      return;
    }
    const body = hits
      .map((h, i) => {
        const score = h.score.toFixed(3);
        return `${i + 1}. [${h.scope}] score=${score}\n   ${h.snippet}\n   来源: ${h.path}`;
      })
      .join("\n\n");
    process.stdout.write(`命中 ${hits.length} 条：\n\n${body}\n`);
  } finally {
    store.dispose();
  }
}

function cmdStats(args) {
  const { store } = setup(args);
  try {
    const rows = readAll(store.index());
    process.stdout.write(`${formatStats(rows)}\n`);
  } finally {
    store.dispose();
  }
}

/** Read a file as UTF-8, returning "" if it doesn't exist. */
function readOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Dump all memory relevant to this project so the LLM can do consolidation
 * (dream) or workflow distillation itself — mirrors the old runDream/runDistill
 * gather step, but the LLM is the driver, so we just hand it the content.
 */
function cmdDump(args) {
  const { store, projectId } = setup(args);
  try {
    const parts = [];
    const globalContent = readOrEmpty(store.paths.globalMemory());
    if (globalContent) parts.push(`## Global memory\n\n${globalContent}`);
    const projectContent = readOrEmpty(store.paths.projectMemory(projectId));
    if (projectContent) parts.push(`## Project memory\n\n${projectContent}`);
    const sessionsDir = store.paths.sessionsDir;
    if (existsSync(sessionsDir)) {
      const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(-20);
      for (const sid of sessionDirs) {
        const cp = readOrEmpty(store.paths.sessionCheckpoint(sid));
        if (cp) parts.push(`## Session checkpoint (${sid})\n\n${cp}`);
      }
    }
    const memory = parts.join("\n\n---\n\n");
    if (!memory.trim()) {
      process.stdout.write("记忆库为空。\n");
      return;
    }
    process.stdout.write(memory + "\n");
  } finally {
    store.dispose();
  }
}

const HELP = `opencode-recall CLI

子命令：
  remember   写入持久事实/规则/决策到项目（或全局）记忆
  checkpoint 存档当前会话工作状态
  note       追加一条会话草稿笔记
  search     检索跨会话记忆与检查点（FTS5）
  stats      查看记忆使用统计
  dump       导出本项目全部记忆（供 LLM 端做收敛/提炼）

通用参数：
  --project <dir>   项目根目录（默认当前工作目录 cwd）
  --session <id>    会话标识（默认按日期分桶 cli-YYYYMMDD）

详见 SKILL.md。`;

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (sub) {
    case "remember":
      return cmdRemember(args);
    case "checkpoint":
      return cmdCheckpoint(args);
    case "note":
      return cmdNote(args);
    case "search":
      return cmdSearch(args);
    case "stats":
      return cmdStats(args);
    case "dump":
      return cmdDump(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP + "\n");
      return;
    default:
      fail(`未知子命令：${sub}\n\n${HELP}`);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`执行失败：${msg}\n`);
  process.exit(1);
});
