import { tool, type Plugin } from "@opencode-ai/plugin";

import { resolveConfig, type RawMemoryConfig } from "./config.ts";
import { memorySearch, type SearchScope } from "./search.ts";
import { projectIdFromPath } from "./storage/paths.ts";
import { MemoryStore } from "./store.ts";
import { rememberFact } from "./write.ts";

const SECTION_VALUES = [
  "rule",
  "architecture_decision",
  "durable_knowledge",
  "pattern",
  "gotcha",
] as const;

const SCOPE_VALUES = ["all", "project", "session", "global"] as const;

/**
 * opencode-memory — M1 (minimal closed loop).
 *
 * Wires up the two tools needed to prove "agent records one fact, later
 * searches and finds it":
 *   - remember_fact : write a durable fact into project/global MEMORY.md
 *   - memory_search : FTS5/BM25 search over stored memories
 *
 * All behavior is explicitly triggered by tool calls. No background timers,
 * no token watchers, no silent spawning (see DESIGN.md §1).
 */
export const MemoryPlugin: Plugin = async ({ client, project, directory, worktree }) => {
  // Resolve config from opencode.json's custom `memory` block (best-effort).
  let rawMemory: RawMemoryConfig | undefined;
  try {
    const cfg = (await client.config.get()) as { data?: Record<string, unknown> };
    const data = cfg?.data ?? (cfg as unknown as Record<string, unknown>);
    rawMemory = data?.["memory"] as RawMemoryConfig | undefined;
  } catch {
    rawMemory = undefined;
  }

  const config = resolveConfig(rawMemory);

  // Stable project id from the repo root. Prefer the worktree (shared across
  // all sessions of a repo), falling back to the plugin directory.
  const projectRoot = project?.worktree || worktree || directory;
  const projectId = projectIdFromPath(projectRoot);

  const store = new MemoryStore(config);

  if (!config.enabled) {
    return { async dispose() {} };
  }

  return {
    async dispose() {
      store.dispose();
    },

    tool: {
      remember_fact: tool({
        description:
          "把一条值得跨会话长期记住的事实/规则/决策写入项目记忆。" +
          "在确立了一个架构决策、用户定了一条规则、发现了一个持久的项目事实时调用。" +
          "不要用于临时的、只在本次对话有意义的内容。",
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
