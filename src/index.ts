import { tool, type Plugin } from "@opencode-ai/plugin";

import {
  CMD_REMEMBER,
  handleRemember,
  injectCommands,
} from "./commands.ts";
import { loadRawConfig, resolveConfig } from "./config.ts";
import { memorySearch, type SearchScope } from "./search.ts";
import { projectIdFromPath } from "./storage/paths.ts";
import { CHECKPOINT_SECTIONS } from "./storage/templates.ts";
import { MemoryStore } from "./store.ts";
import { appendNote, rememberFact, saveCheckpoint } from "./write.ts";

const SECTION_VALUES = [
  "rule",
  "architecture_decision",
  "durable_knowledge",
  "pattern",
  "gotcha",
] as const;

const SCOPE_VALUES = ["all", "project", "session", "global"] as const;

/**
 * Overwrite the message parts of a command turn with a single text message.
 * Used by the /remember intercept so the deterministic write result is what the
 * user sees, instead of the (unused) template body reaching the agent.
 */
function replacePartsWithText(parts: { type: string; text?: string }[], message: string): void {
  let placed = false;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (part.type !== "text") continue;
    if (!placed) {
      part.text = message;
      placed = true;
    } else {
      parts.splice(i, 1);
    }
  }
  if (!placed) {
    parts.push({ type: "text", text: message } as (typeof parts)[number]);
  }
}

/**
 * opencode-memory — M1 + M2.
 *
 * M1 (minimal loop): remember_fact + memory_search.
 * M2 (full write):   save_checkpoint + note tools, checkpoint template with
 *                    section merge, and the /checkpoint + /remember commands.
 *
 * All behavior is explicitly triggered by tool calls or user commands. No
 * background timers, no token watchers, no silent spawning (see DESIGN.md §1).
 */
export const MemoryPlugin: Plugin = async ({ project, directory, worktree }) => {
  // Stable project root: prefer the worktree (shared across all sessions of a
  // repo), falling back to the plugin directory.
  const projectRoot = project?.worktree || worktree || directory;

  // Config source: a standalone `.opencode/memory.json` file plus env overrides.
  //
  // We deliberately do NOT put config under opencode.json's `memory` key —
  // upstream opencode strictly validates that file and REJECTS unknown keys
  // ("Unrecognized key: memory"), which breaks the whole session. The plugin
  // owns its own config file, which opencode never parses. See DESIGN.md §7.
  const rawMemory = loadRawConfig(projectRoot);
  const config = resolveConfig(rawMemory);

  const projectId = projectIdFromPath(projectRoot);

  const store = new MemoryStore(config);

  if (!config.enabled) {
    return { async dispose() {} };
  }

  const checkpointFieldDesc = CHECKPOINT_SECTIONS.map(
    (s) => `${s.key}(${s.heading})`,
  ).join("、");

  return {
    async dispose() {
      store.dispose();
    },

    // Register /checkpoint and /remember by mutating the resolved config.
    async config(cfg) {
      injectCommands(cfg);
    },

    // Deterministically handle /remember: write straight to project memory and
    // rewrite the command turn with the result (no LLM needed for the write).
    async "command.execute.before"(input, output) {
      if (input.command !== CMD_REMEMBER) return;
      const result = await handleRemember(input.arguments, { store, projectId });
      if (result.handled) {
        replacePartsWithText(
          output.parts as unknown as { type: string; text?: string }[],
          result.message,
        );
      }
    },

    tool: {
      remember_fact: tool({
        description:
          "把一条值得跨会话长期记住的事实/规则/决策写入项目记忆。" +
          "在确立了一个架构决策、用户定了一条规则、发现了一个持久的项目事实时调用。" +
          "不要用于临时的、只在本次对话有意义的内容（那些用 save_checkpoint）。",
        args: {
          section: tool.schema
            .enum(SECTION_VALUES)
            .describe(
              "记忆段：rule(规则) / architecture_decision(架构决策) / " +
                "durable_knowledge(持久知识) / pattern(模式) / gotcha(坑)",
            ),
          content: tool.schema.string().describe("1-3 行，简洁高信号"),
          global: tool.schema
            .boolean()
            .optional()
            .describe("true 表示这条跨项目通用，写入全局记忆而非项目记忆"),
        },
        async execute(args) {
          const result = await rememberFact(
            {
              section: args.section,
              content: args.content,
              global: args.global,
            },
            { store, projectId },
          );
          const verb =
            result.outcome === "added"
              ? "已记录"
              : result.outcome === "updated"
                ? "已更新已有条目"
                : "已存在，跳过";
          return {
            title: `remember_fact: ${result.outcome}`,
            output: `${verb}（${result.scope} 记忆，段=${args.section}）\n${result.path}`,
          };
        },
      }),

      save_checkpoint: tool({
        description:
          "把当前会话的工作状态存档到会话检查点。" +
          "在完成一个阶段性任务、即将切换到另一块工作、或对话信息量已经很大时调用。" +
          "用于保存“现在进行到哪、下一步是什么、涉及哪些文件”这类会话级状态；" +
          "持久的跨会话事实用 remember_fact，零散备忘用 note。",
        args: {
          intent: tool.schema.string().optional().describe("当前意图：用户最近的明确诉求，尽量原话"),
          next_action: tool.schema.string().optional().describe("下一步：单个最具体的下一步动作"),
          current_work: tool.schema.string().optional().describe("当前工作：正在做什么、涉及哪些代码位置"),
          files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("涉及文件：活跃读写的文件 + 一句话用途"),
          discovered: tool.schema.string().optional().describe("发现的知识：本会话学到、可能对未来有用的事实"),
          errors_fixes: tool.schema.string().optional().describe("错误与修复：踩的坑及解决方式"),
          decisions: tool.schema.string().optional().describe("设计决策：讨论得出的决定 + 理由"),
          open_questions: tool.schema.string().optional().describe("开放问题：未决事项、杂项"),
        },
        async execute(args, context) {
          const result = await saveCheckpoint(
            {
              intent: args.intent,
              next_action: args.next_action,
              current_work: args.current_work,
              files: args.files,
              discovered: args.discovered,
              errors_fixes: args.errors_fixes,
              decisions: args.decisions,
              open_questions: args.open_questions,
            },
            { store, sessionId: context.sessionID },
          );
          if (result.changed.length === 0) {
            return {
              title: "save_checkpoint: 无更新",
              output: "没有提供任何内容，检查点未改动。",
            };
          }
          return {
            title: `save_checkpoint: 更新 ${result.changed.length} 段`,
            output: `已存档检查点（${result.changed.join(", ")}）\n${result.path}`,
          };
        },
      }),

      note: tool({
        description: "追加一条简短笔记到会话草稿本，用于零散观察、待办、临时备忘。",
        args: { content: tool.schema.string().describe("一句话笔记") },
        async execute(args, context) {
          const result = await appendNote(args.content, {
            store,
            sessionId: context.sessionID,
          });
          return {
            title: "note: 已追加",
            output: `已记到会话草稿本\n${result.path}`,
          };
        },
      }),

      memory_search: tool({
        description:
          "搜索跨会话的项目记忆与历史检查点。" +
          "当你需要回忆早先的决策、踩过的坑、用户定过的规则、或本项目的背景知识时使用。" +
          "返回的是已存档的高信号记忆片段，不是源码——查源码用 grep。",
        args: {
          query: tool.schema.string().describe("自然语言或关键词查询"),
          scope: tool.schema
            .enum(SCOPE_VALUES)
            .optional()
            .describe("检索范围，默认 all（项目+全局+当前会话）"),
          limit: tool.schema.number().optional().describe("返回条数上限"),
        },
        async execute(args, context) {
          const hits = await memorySearch(
            {
              query: args.query,
              scope: args.scope as SearchScope | undefined,
              limit: args.limit,
            },
            { store, projectId, sessionId: context.sessionID },
          );

          if (hits.length === 0) {
            return {
              title: "memory_search: 0 条",
              output: "没有找到相关记忆。",
            };
          }

          const body = hits
            .map((h, i) => {
              const score = h.score.toFixed(3);
              return `${i + 1}. [${h.scope}] score=${score}\n   ${h.snippet}\n   来源: ${h.path}`;
            })
            .join("\n\n");

          return {
            title: `memory_search: ${hits.length} 条`,
            output: body,
          };
        },
      }),
    },
  };
};

export default MemoryPlugin;
