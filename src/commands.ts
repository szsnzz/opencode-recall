import type { Config } from "@opencode-ai/plugin";

import { rememberFact, type RememberFactDeps } from "./write.ts";

/**
 * Command names owned by this plugin. Kept as constants so the intercept hook
 * and the injection stay in sync.
 */
export const CMD_CHECKPOINT = "checkpoint";
export const CMD_REMEMBER = "remember";
export const CMD_DREAM = "dream";
export const CMD_DISTILL = "distill";

/**
 * Inject the plugin's commands into the resolved config at load time.
 *
 * opencode plugins cannot register commands through the Hooks return object;
 * the supported runtime path is mutating `config.command`. We only add a
 * command if the user hasn't already defined one with the same name (so a
 * project-level override always wins).
 *
 * - /checkpoint : a guidance prompt that drives the agent to call
 *   save_checkpoint with a full session snapshot. (Agent produces the content;
 *   it alone has the full context — see DESIGN.md §4.2.)
 * - /remember   : handled deterministically by the intercept below, but we
 *   still register a stub so the command exists in the picker and produces a
 *   message turn we can rewrite.
 */
export function injectCommands(config: Config): void {
  const command = (config.command ??= {});

  if (!command[CMD_CHECKPOINT]) {
    command[CMD_CHECKPOINT] = {
      description: "立即生成并存档一份完整的会话检查点",
      template:
        "请基于当前会话的全部上下文，调用 save_checkpoint 工具存档一份完整的检查点。\n" +
        "尽量填全这些字段：当前意图(intent)、下一步(next_action)、当前工作(current_work)、" +
        "涉及文件(files)、发现的知识(discovered)、错误与修复(errors_fixes)、" +
        "设计决策(decisions)、开放问题(open_questions)。\n" +
        "字段内容要简洁、高信号；没有内容的字段就留空，不要编造。\n" +
        "$ARGUMENTS",
    };
  }

  if (!command[CMD_REMEMBER]) {
    command[CMD_REMEMBER] = {
      description: "把一条事实快速写入项目记忆（durable_knowledge）",
      template:
        "（记忆插件已直接处理 /remember，无需进一步操作。）\n$ARGUMENTS",
    };
  }

  if (!command[CMD_DREAM]) {
    command[CMD_DREAM] = {
      description: "合并去重记忆、晋升持久知识到项目/全局记忆",
      template: "（记忆插件正在运行 dream，请稍候。）\n$ARGUMENTS",
    };
  }

  if (!command[CMD_DISTILL]) {
    command[CMD_DISTILL] = {
      description: "识别重复工作流，提炼为 skill/command 建议",
      template: "（记忆插件正在运行 distill，请稍候。）\n$ARGUMENTS",
    };
  }
}

export interface RememberInterceptResult {
  handled: boolean;
  message: string;
}

/**
 * Deterministically handle `/remember <text>`: write the text into the project
 * memory's durable_knowledge section right away, with no LLM involvement for
 * the write itself. Returns a short message to surface as the command's turn.
 *
 * This is write gate A (the user-command backstop): it captures a fact even
 * when the agent forgot to call remember_fact.
 */
export async function handleRemember(
  args: string,
  deps: RememberFactDeps,
): Promise<RememberInterceptResult> {
  const content = args?.trim();
  if (!content) {
    return {
      handled: true,
      message: "用法：/remember <要记住的事实>",
    };
  }

  try {
    const result = await rememberFact(
      { section: "durable_knowledge", content },
      deps,
    );
    const verb =
      result.outcome === "added"
        ? "已记录到项目记忆"
        : result.outcome === "updated"
          ? "已更新项目记忆中的已有条目"
          : "该事实已存在，跳过";
    return { handled: true, message: `${verb}：${content}\n${result.path}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { handled: true, message: `记忆写入失败：${msg}` };
  }
}
