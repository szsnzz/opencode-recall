---
name: opencode-recall
description: 跨会话长期记忆——显式写入高信号事实/规则/决策/坑，按需用 FTS5 全文检索回忆，三层（会话/项目/全局）存储。触发：用户说"记住/记一下/存档/记到记忆"，或需要回忆早先的决策、踩过的坑、定过的规则、项目背景时；以及用户要求"看记忆统计/收敛记忆/提炼工作流"。
---

# opencode-recall

opencode 的长期记忆系统。**显式写入 + 按需检索**：值得跨会话记住的内容才写，需要时主动检索回忆，不做后台静默注入，对 prompt 缓存零影响。

后端是一个零运行时依赖的 Node CLI（只用 `node:sqlite`），数据以 markdown + SQLite FTS5 索引存盘。本 skill 通过 shell 调用该 CLI。

## 运行环境

- **Node.js ≥ 22.5**（用到内置 `node:sqlite`）。用 `node` 直接运行，无需安装任何依赖。
- CLI 入口：本 skill 目录下的 `cli.mjs`。下文用 `<CLI>` 指代它的绝对路径，即
  `~/.config/opencode/skills/opencode-recall/cli.mjs`（Windows：`C:\Users\<你>\.config\opencode\skills\opencode-recall\cli.mjs`）。

## 关键约定（务必遵守）

1. **`--project` 永远传当前工作目录的绝对路径**（即用户当前项目根）。记忆按 project 隔离，传错会写到别的项目。在 PowerShell 用 `$PWD`，bash 用 `$(pwd)`。
2. **调用是显式的、低频的**：只在确实值得长期记住、或确实需要回忆时调用。不要每轮对话都写。
3. 写入用 `remember`（持久事实）、`checkpoint`（会话工作状态）、`note`（零散备忘）三选一，按下文判据区分。
4. 命令产生 markdown 写到记忆库；检索返回高信号片段，**不是源码**——查源码仍用 grep/读文件。

## 何时调用各命令

### remember —— 写入持久的、跨会话有意义的事实
触发：确立了一条架构决策、用户定下一条规则、发现了一个持久的项目事实/坑。
不要用于只在本次对话有意义的临时状态（那用 checkpoint）。

```
node "<CLI>" remember --project "<PWD>" --section <段> --content "<1-3行简洁高信号>" [--global]
```
- `--section` 取值：`rule`(规则) / `architecture_decision`(架构决策) / `durable_knowledge`(持久知识) / `pattern`(模式) / `gotcha`(坑)
- `--global`：这条跨项目通用时加上，写入全局记忆而非当前项目。
- 幂等：相同内容重复写会被识别为"已存在，跳过"。

### checkpoint —— 存档当前会话工作状态
触发：完成一个阶段性任务、即将切换工作块、或对话信息量已经很大、用户说"存档/记一下进度"。

```
node "<CLI>" checkpoint --project "<PWD>" [--session <id>] \
  --intent "用户最近的明确诉求(尽量原话)" \
  --next-action "下一步最具体的单个动作" \
  --current-work "正在做什么、涉及哪些代码位置" \
  --files "路径1,路径2" \
  --discovered "本会话学到、对未来有用的事实" \
  --errors-fixes "踩的坑及解决方式" \
  --decisions "讨论得出的决定+理由" \
  --open-questions "未决事项"
```
- 所有字段可选，只传有内容的。文本字段直接覆盖，`--files` 是逗号分隔、会去重合并。
- `--session` 不传时按当天日期分桶（`cli-YYYYMMDD`），同一天的检查点会归并到一起。

### note —— 追加一条零散备忘
触发：临时观察、待办、轻量备忘，够不上 remember 也不是完整 checkpoint。

```
node "<CLI>" note --project "<PWD>" [--session <id>] --content "一句话笔记"
```

### search —— 回忆
触发：需要回忆早先的决策、踩过的坑、用户定过的规则、项目背景；不确定某事之前是否记过。

```
node "<CLI>" search --project "<PWD>" --query "自然语言或关键词" [--scope all|project|session|global] [--limit N]
```
- `--scope` 默认 `all`（当前项目 + 全局 + 当前会话），不会泄漏其它项目/会话的记忆。
- 返回按相关度排序的高信号片段及来源文件路径。

### stats —— 查看记忆使用统计
```
node "<CLI>" stats --project "<PWD>"
```

### dump —— 导出全部记忆做收敛/提炼（dream / distill）
当用户要求"收敛记忆 / 整理记忆 / 提炼工作流"时：先 dump 拿到全部记忆内容，**再由你（LLM）亲自**做合并去重、把分散在各 checkpoint 的持久知识用 `remember` 晋升到项目/全局记忆。

```
node "<CLI>" dump --project "<PWD>"
```
拿到输出后：
- **收敛(dream)**：合并相似条目、删除过时项、相对日期改绝对日期、用 grep 验证提到的路径/函数是否还在、失效的删掉；全局性偏好用 `remember --global` 晋升。
- **提炼(distill)**：识别重复出现的手工工作流，建议沉淀成新的 opencode skill 或 command；没有就直说"暂无值得提炼的"。

## 配置（可选）

项目根的 `.opencode/memory.json`（CLI 自动读取，opencode 不解析此文件）：

```json
{
  "root": "./_memory_data",
  "search": { "scoreFloor": 0.15, "limit": 10 },
  "log": { "level": "info" }
}
```
- `root`：记忆存放目录。相对路径相对**项目根**解析；缺省时存到用户级默认目录。`~` 展开为家目录。
- 全部字段都有默认值，文件可省略。

## 调用示例（PowerShell）

```powershell
node "$HOME\.config\opencode\skills\opencode-recall\cli.mjs" remember --project "$PWD" --section gotcha --content "Windows 桌面版 opencode 插件安装会因 @opencode-ai/plugin@local 失败，故改用 skill"
node "$HOME\.config\opencode\skills\opencode-recall\cli.mjs" search --project "$PWD" --query "插件安装失败"
```

## 调用示例（bash）

```bash
CLI="$HOME/.config/opencode/skills/opencode-recall/cli.mjs"
node "$CLI" remember --project "$(pwd)" --section rule --content "提交信息用祈使句，首字母小写"
node "$CLI" search --project "$(pwd)" --query "提交信息规范"
```
