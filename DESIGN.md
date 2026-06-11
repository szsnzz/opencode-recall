# opencode-recall 架构设计

一个为上游官方 opencode 设计的记忆插件。让 opencode 长出"自动记笔记 + 可被检索"的外挂长期记忆系统：记忆的产生由 agent 工具调用和用户命令**显式**发起，记忆的使用靠 agent **按需检索**。

> 灵感来源：小米 MiMo Code（OpenCode 的 fork）的记忆系统。本项目不 fork 引擎，纯插件实现，因此刻意放弃了 MiMo 那套需要改核心的"上下文无损重建（换页）"，只保留插件层能稳定落地的部分。

---

## 1. 设计边界与原则

### 已定决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 平台 | 上游官方 opencode，`@opencode-ai/sdk` + `@opencode-ai/plugin`；插件运行时是 **Node.js**（见 §1.1） | 可移植，不绑定 fork |
| 记忆**读取** | 只做"方案 B"：agent 主动检索（`memory_search` 工具），**不注入上下文** | 对 prompt 缓存零影响、不占额度、不污染上下文 |
| 记忆**写入** | **显式触发**：A（用户命令）+ B（agent 工具），二者并存 | 砍掉最不稳定的自动触发器；天然成为质量闸门，避免记忆冗杂 |
| 写入工具粒度 | 拆成语义清晰的多个工具，而非一个万能工具 | 对模型更友好，更容易"用对" |
| 分层 | 会话 / 项目 / 全局 三层全要，带晋升链 | 与 MiMo 一致，覆盖不同生命周期 |
| 明确不做 | 上下文无损重建（换页）、token 阈值自动触发、后台静默 spawn | 引擎够不着 / 不稳定 / 信噪比差 |

### 核心原则

1. **零后台静默行为。** 插件的每一个动作都由 agent 的工具调用或用户的命令显式发起。没有定时器、没有 token 监听、没有暗中 spawn。行为完全可预测、可解释、成本可控。
2. **记忆价值在密度，不在完整。** 显式触发即质量闸门——存下来的都是"被判断为值得记"的条目，而非机械快照。
3. **写入器不跑后台 LLM。** 要记的内容由主 agent 在它自己的上下文里当场产出（它本就掌握全部信息），通过工具交给插件**直接落盘**。唯一需要额外跑 LLM 的地方是收敛命令（dream/distill）。
4. **文件 + SQLite 解耦。** 模块间只通过"Markdown 文件 + FTS5 索引"通信，任何一块都能独立测试。

### 1.1 运行时约束（联调实测，务必遵守）

这些是把插件真正跑进 opencode **桌面版**时踩出来、并已验证的硬约束。它们推翻了初版设计的几个假设，后续改代码不要违反：

| 约束 | 实测结论 | 影响 |
|---|---|---|
| **运行时是 Node.js，不是 Bun** | 桌面版用 `diag` 工具实测：`Bun` 全局不存在，`process.versions.node = v24.x` | 不能用任何 `Bun.*` API |
| **SQLite 用 `node:sqlite`** | `bun:sqlite` 在 Node 下报 `No such built-in module`，整个插件静默加载失败 | 存储层走 Node 内置 `node:sqlite`（`DatabaseSync`，自带 FTS5）。封装在 `src/storage/sqlite.ts`，对外保持 `bun:sqlite` 风格 API |
| **禁用 TS 参数属性等非"纯类型"语法** | opencode 用 Node 的 **type-stripping** 加载 `.ts`，遇到 `constructor(private x)` 直接 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | 源码与测试一律不用参数属性、`enum`、`namespace`；类型导入用 `import type` / 内联 `type` |
| **配置走独立文件，不进 opencode.json** | opencode 严格校验 `opencode.json`，未知顶层 key（如 `memory`）会报错并使整个会话起不来 | 配置放 `.opencode/memory.json`（opencode 不解析），见 §7 |
| **本地插件依赖要预装** | 桌面版自身版本为 `local`，会尝试 `@opencode-ai/plugin@local`（不存在）→ 后台安装失败 | `.opencode/package.json` 显式声明 `@opencode-ai/plugin` 版本并预装；插件文件用具名或 default 导出均可 |
| **projectRoot 取 `directory`，不轻信 `worktree`** | 非 git 目录时 opencode 把项目当 `global`、`worktree="/"`，会让配置查找与项目身份算到根目录 | 用 `pickProjectRoot()`：worktree 是真实路径才用，否则退回 `directory`（见 `src/index.ts`） |
| **测试用 `node --test`** | bun 缺 `node:sqlite`，DB 测试在 `bun test` 下必然失败 | 测试运行时与生产一致：`node --experimental-strip-types --test`；`test/helpers/bun-test-shim.ts` 兼容旧的 `expect` 风格 |


---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│                   opencode 主会话（用户）                   │
└──────┬───────────────┬────────────────┬──────────────────┘
       │ tool          │ tool           │ command
       │ memory_search │ remember_fact  │ /checkpoint /remember
       │               │ save_checkpoint│ /dream /distill
       ▼               ▼                ▼
┌─────────────┐ ┌──────────────┐ ┌──────────────────────────┐
│ ④ 检索层     │ │ ② 写入层      │ │ ⑤ 收敛层                  │
│ FTS5 + BM25 │ │ 校验 + 落盘   │ │ /dream  合并去重 + 晋升     │
│ scope 过滤   │ │ 模板渲染      │ │ /distill 沉淀工作流为技能   │
│ 相对分数地板 │ │ 三层路由      │ │ （唯一跑 LLM 的地方）       │
└──────┬──────┘ └──────┬───────┘ └───────────┬──────────────┘
       │ 读            │ 写                    │ 读历史+写记忆
       ▼               ▼                       ▼
┌──────────────────────────────────────────────────────────┐
│ ③ 存储层                                                   │
│  - Markdown 文件（global / projects / sessions 三层）       │
│  - SQLite FTS5 索引（node:sqlite，插件自管，不碰 opencode 库）│
│  - reconcile 增量扫盘同步                                   │
└──────────────────────────────────────────────────────────┘
```

四个模块：**存储、写入、检索、收敛**。相比初版，**触发器模块已完全删除**，写入层也从"后台 spawn 子会话 + 小模型总结"简化为"工具 execute 体里直接落盘"。

---

## 3. 存储层 ③

### 3.1 文件布局（三层）

```
<memoryRoot>/
├── global/MEMORY.md                  # 全局：跨项目用户偏好/习惯（最稳定）
├── projects/<projectId>/MEMORY.md    # 项目：跨会话长期知识
└── sessions/<sessionId>/
    ├── checkpoint.md                 # 会话：当前状态（分段模板）
    └── notes.md                      # 会话：自由草稿（可选）
```

- `<memoryRoot>` 默认 `~/.config/opencode/memory/`（与 opencode 配置同根，原生感强）。可配置为独立目录以便隔离/卸载。
- `projectId` = 项目根绝对路径的 `sha256` 取前 12 位（路径从 `client.project.current()` / 插件 `directory` 取）。**同一仓库的所有会话共享同一份项目 MEMORY.md** —— 这是"关机不忘事"的来源。
- `sessionId` 由插件 hook 的 `input.sessionID` 提供。

### 3.2 checkpoint.md 模板（分段，带 token 预算）

借鉴 MiMo 的结构，精简为更适合显式写入的若干段。每段有软预算，写入时超限截断：

| 段 | 内容 | 预算(tok) |
|---|---|---|
| §1 当前意图 | 用户最近的明确诉求（尽量原话） | 500 |
| §2 下一步 | 单个最具体的下一步动作 | 800 |
| §3 当前工作 | 正在做什么，涉及哪些文件/代码位置 | 2000 |
| §4 涉及文件 | 活跃读写的文件 + 一句话用途 | 1500 |
| §5 发现的知识 | 本会话学到、可能对未来有用的事实（晋升候选） | 2000 |
| §6 错误与修复 | 踩的坑及解决方式，新的在前 | 1500 |
| §7 设计决策 | 讨论得出的决定 + 理由（"为什么这么做"） | 2000 |
| §8 开放问题 | 未决事项、杂项 | 800 |

### 3.3 MEMORY.md 模板（项目级 / 全局级）

| 段 | 内容 |
|---|---|
| Project context | 这项目是干嘛的、目标 |
| Rules | 用户明确定下的硬性约束 |
| Architecture decisions | 重大设计选择 + 绝对日期 + 理由 |
| Discovered durable knowledge | 跨会话持久的事实（从 checkpoint §5 晋升而来） |
| Patterns / Gotchas | 重复出现的问题与解法、易踩的坑 |

全局 MEMORY.md 用 `# Global memory` 标题，只放跨项目通用的偏好。

### 3.4 SQLite FTS5 索引（插件自建）

用 `node:sqlite`（Node 内置，含 FTS5；封装见 `src/storage/sqlite.ts`），独立文件 `<memoryRoot>/index.db`，**绝不触碰 opencode 自己的数据库**：

```sql
CREATE TABLE memory_doc (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE NOT NULL,   -- 文件绝对路径
  scope       TEXT NOT NULL,          -- 'global' | 'projects' | 'sessions'
  scope_id    TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL,          -- 'memory' | 'checkpoint' | 'notes'
  fingerprint TEXT NOT NULL,          -- 内容 sha256，用于增量索引
  indexed_at  INTEGER NOT NULL
);
CREATE INDEX memory_doc_scope_idx ON memory_doc(scope, scope_id);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  body,
  tokenize = 'porter unicode61'
);
-- memory_fts.rowid 与 memory_doc.id 对齐
```

检索 = `bm25(memory_fts)` 排序 + `snippet()` 出高亮片段。**不用 embedding/向量**：延迟低、零外部依赖、可解释。

### 3.5 reconcile（增量同步）

检索前惰性执行：扫盘比对每个文件的 `fingerprint`，仅对新增/变更文件重建 FTS 行，删除已不存在的文件行。覆盖两种场景：

- 写入器落盘后立即可被搜到；
- 用户手动编辑过记忆文件也能被纳入索引。

### 3.6 FTS 查询构建

用户 query 需做 token 化以免 FTS5 MATCH 解析器崩溃：标点变分隔符、每个字母数字串短语化（`"..."`）后 OR 连接。OR 连接的副作用（只命中常见词的文档也匹配）由检索层的"相对分数地板"处理（见 §5）。

---

## 4. 写入层 ②（显式触发，A + B）

写入层是**纯同步落盘**，不跑后台 LLM。要写的结构化内容由调用方（agent 或命令）提供，插件负责校验、模板渲染、三层路由、原子写、触发 reconcile。

### 4.1 写入闸门 B：agent 工具（拆成语义清晰的多个）

提供三个工具，让 agent 在不同场景按语义选择，比单个万能工具更容易"用对"：

```ts
// 工具 1：记一条持久事实到【项目记忆】
remember_fact: tool({
  description:
    "把一条值得跨会话长期记住的事实/规则/决策写入项目记忆。" +
    "在确立了一个架构决策、用户定了一条规则、发现了一个持久的项目事实时调用。" +
    "不要用于临时的、只在本次对话有意义的内容（那些用 save_checkpoint）。",
  args: {
    section: tool.schema.enum([
      "rule", "architecture_decision", "durable_knowledge", "pattern", "gotcha",
    ]),
    content: tool.schema.string().describe("1-3 行，简洁高信号"),
    global: tool.schema.boolean().optional()
      .describe("true 表示这条跨项目通用，写入全局记忆而非项目记忆"),
  },
  // execute: 合并进对应 MEMORY.md 的对应段（去重：相似已存在则跳过/更新）
})

// 工具 2：存当前【会话状态】到 checkpoint
save_checkpoint: tool({
  description:
    "把当前会话的工作状态存档到会话检查点。" +
    "在完成一个阶段性任务、即将切换到另一块工作、或对话信息量已经很大时调用。" +
    "用于保存'现在进行到哪、下一步是什么、涉及哪些文件'这类会话级状态。",
  args: {
    intent: tool.schema.string().optional(),        // §1
    next_action: tool.schema.string().optional(),   // §2
    current_work: tool.schema.string().optional(),  // §3
    files: tool.schema.array(tool.schema.string()).optional(), // §4
    discovered: tool.schema.string().optional(),    // §5
    errors_fixes: tool.schema.string().optional(),  // §6
    decisions: tool.schema.string().optional(),     // §7
    open_questions: tool.schema.string().optional(),// §8
  },
  // execute: 渲染/合并进 sessions/<sid>/checkpoint.md，已有段做增量更新
})

// 工具 3：追加一条自由草稿到会话 notes（最轻量）
note: tool({
  description: "追加一条简短笔记到会话草稿本，用于零散观察、待办、临时备忘。",
  args: { content: tool.schema.string() },
  // execute: append 到 sessions/<sid>/notes.md，带时间戳
})
```

工具描述刻意写得"有引导性"——明确告诉模型**何时**该调、以及三者的分工边界。这是写入闸门 B 成败的关键。

### 4.2 写入闸门 A：用户命令

作为强制补刀和"立即存档"入口（覆盖 agent 忘记自觉记录的情况）：

| 命令 | 行为 |
|---|---|
| `/checkpoint` | 让当前 agent 立即生成一份完整 checkpoint（内部即引导 agent 调 `save_checkpoint`） |
| `/remember <文本>` | 把一条事实快速写入项目记忆的 `durable_knowledge` 段 |

命令通过 opencode 的 command 机制实现（`.opencode/command/` 或插件注册）。`/checkpoint` 本质是一段引导 prompt + `save_checkpoint` 工具的组合。

### 4.3 落盘细节

- **结构化输入直接落盘**：无需让模型碰文件路径，从源头避免 MiMo 那类"模型臆造路径"问题，也无权限风险。
- **去重合并**：写 MEMORY.md 时按段合并，相似条目更新而非追加（简单文本相似度即可，避免库膨胀）。
- **原子写**：临时文件 + `rename`，避免并发会话写坏同一项目 MEMORY.md。
- **写后 reconcile**：更新 FTS 索引，保证 `memory_search` 立刻能搜到。

---

## 5. 检索层 ④（方案 B 的全部）

注册一个工具，是记忆"被使用"的唯一通道：

```ts
memory_search: tool({
  description:
    "搜索跨会话的项目记忆与历史检查点。" +
    "当你需要回忆早先的决策、踩过的坑、用户定过的规则、或本项目的背景知识时使用。" +
    "返回的是已存档的高信号记忆片段，不是源码——查源码用 grep。",
  args: {
    query: tool.schema.string(),
    scope: tool.schema.enum(["all", "project", "session", "global"]).optional(),
    limit: tool.schema.number().optional(),
  },
  execute: async (args) => { /* reconcile → FTS5 MATCH → BM25 → 地板过滤 → 片段 */ },
})
```

- **默认 scope**：`项目 + 全局 + 当前会话`（SQL 过滤，绝不泄漏其他会话/项目的记忆）。
- **相对分数地板**：保留分数 ≥ 最高分 × `scoreFloor`（默认 0.15）的结果，但第一名永远保留。过滤只命中常见词的噪音。相对而非绝对，因为小语料下 BM25 分数会整体塌缩。
- **返回**：每条含 `path`（来源）+ `snippet`（高亮片段）+ `score`。
- **刻意不注入上下文**：不挂 system prompt、不挂 user message。代价是依赖模型自觉调用——这是"只做方案 B"的固有取舍，已接受。`memory_search` 的描述质量直接决定召回是否被用上。

---

## 6. 收敛层 ⑤

`/dream` 和 `/distill` 命令。这是插件中**唯一**需要额外跑 LLM 的部分，且由用户显式触发，符合"零后台静默行为"原则。

> **当前实现状态（v1，有意简化）**：收敛层先用一个最小框架跑一段时间，收集真实使用反馈后再决定是否加重。下面每节的"设计目标"是完整愿景，"当前实现"是这一版实际做的，差异均为**有意的成本/安全取舍**，不是遗漏。详见各节末的取舍说明。

### `/dream` — 记忆合并与晋升

**设计目标**：读历史会话（`session.list` + `session.messages`）+ 现有记忆文件，喂一次 `session.prompt`，让模型：

- 把分散在各 checkpoint 的发现合并去重；
- 把相对日期转绝对日期；
- 删除被推翻的过时条目；
- 验证提到的文件路径/函数名是否还存在；
- 沿晋升链收敛：**会话发现（checkpoint §5）→ 项目记忆 → 全局记忆**；
- 保持 MEMORY.md 紧凑（建议 < 200 行 / 10KB）。

**当前实现（`src/consolidate.ts`）**：输入源**只取已浓缩的 checkpoint + 项目/全局 MEMORY**（最近 20 个 checkpoint），**不读原始 `session.messages`**。其余收敛逻辑（合并去重、绝对日期、grep 验证、晋升、紧凑）全部通过 prompt 交给模型。

> **取舍：暂不读原始会话历史。** `session.messages` 会返回每条消息的完整 parts，**包含 tool 调用的输入输出**（`read`/`grep`/`bash` 的结果动辄数万 token）。把多个会话的全量轨迹塞进一个 prompt 既贵又容易超窗截断。而 checkpoint 本身就是"已经被判断为值得记"的浓缩产物，作为默认输入源**便宜且信号密度高**。
> 代价：dream 只能收敛"已进入 checkpoint 的内容"，无法从原始对话里挖掘漏记的持久知识——晋升链的源头窄了一截。
> 后续方向（待反馈再定）：把历史消息做成**可选的、带 token 预算上限的增强源**——用 `session.messages` 的 `limit` 限条数、用 `AssistantMessage.tokens` 累计设上限、剥离 ToolPart 大输出只留文本，默认关闭或低预算。

### `/distill` — 工作流沉淀

**设计目标**：回看历史，识别重复出现的手工工作流，把高置信度的建议沉淀成 opencode 的 skill / command / subagent。"没有重复就什么都不建"是合法结果。

**当前实现（`src/consolidate.ts`）**：喂记忆内容给模型，让它**口头给出**"可沉淀为 skill/command 的建议"（名称、触发时机、模板内容），**不自动写文件**。没有识别到重复模式时回答"暂无值得提炼的工作流"。

> **取舍：只产出建议，不自动落地为可执行资产。** opencode SDK 的 `command` / agent 只有 `list`（读），没有 create/write —— "落地"只能靠往 `.opencode/commands/`、`.opencode/agent/`、`.opencode/skills/` 写文件。但让 LLM **自动生成并写入可执行资产**等于让它自动改项目配置，是高风险行为（文件名注入、覆盖用户已有资产、生成不可信的可执行 prompt）。第一版先停在"建议"阶段。
> 后续方向（待反馈再定）：两段式落地——distill 产出**结构化建议草稿**写到 `_memory_data/suggestions/`（复用 `assertSafeId` 做文件名安全、不覆盖已有资产），由用户确认后再落地到 `.opencode/`。

> 与 MiMo 的差异：MiMo 直接读全量轨迹库 `mimocode.db`；上游 opencode 没有等价的公开库，只能走 SDK 读历史消息（见上面 dream 的取舍）。两个命令支持"距上次运行超过 N 天才允许跑"的软提醒（`intervalDays` + `.dream_last_run`/`.distill_last_run` 时间戳，`0` 表示强制运行），但**不做自动定时**。


---

## 7. 配置（独立文件 `.opencode/memory.json`）

> **重要修正（联调发现）**：最初设计打算把配置放在 `opencode.json` 的 `memory`
> 段、用 `client.config.get()` 读取。实测发现**上游官方 opencode 对
> `opencode.json` 做严格 schema 校验，拒绝任何未知顶层 key**，会报
> `Unrecognized key: memory` 并导致整个会话无法开启。MiMo 能用是因为它是 fork，
> 把 `memory` 加进了自己的 schema。因此插件改为从**自己拥有、opencode 不解析**
> 的独立文件读取配置。

插件从项目根的 `.opencode/memory.json` 读取配置（opencode 不会校验此文件）：

```jsonc
// <projectRoot>/.opencode/memory.json
{
  "enabled": true,
  "root": "~/.config/opencode/memory",   // 记忆根目录，可改为独立目录
  "search": {
    "scoreFloor": 0.15,
    "limit": 10
  },
  "dream":   { "intervalDays": 7  },       // 仅用于软提醒，不自动跑
  "distill": { "intervalDays": 30 },
  "log":     { "level": "info" },           // debug | info | warn | error（M5）
  "metrics": { "enabled": true }            // 轻量使用计数，落在插件自建 SQLite（M5）
}
```

插件本身仍通过 `opencode.json` 的 `plugin` 字段（或本地 `.opencode/plugins/`）加载——
那是 opencode 认识的合法字段。只有**插件自己的配置**走独立文件。

环境变量覆盖（later wins）：
- `OPENCODE_MEMORY_ROOT` — 覆盖记忆根目录
- `OPENCODE_MEMORY_DISABLED=1` — 硬关闭插件

注意：**没有任何 `thresholds` / `writeOnIdle` / `auto` 配置**——因为不存在自动触发。

---

## 8. 代码结构

```
opencode-recall/
├── DESIGN.md
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # Plugin 入口：装配 tools + commands + config
│   ├── config.ts           # 配置解析 + 默认值
│   ├── storage/
│   │   ├── paths.ts        # 三层路径解析/构建（防路径穿越）
│   │   ├── index-db.ts     # node:sqlite + FTS5 schema 初始化
│   │   ├── reconcile.ts    # 增量索引（fingerprint 比对）
│   │   ├── fts-query.ts    # 查询 token 化
│   │   └── templates.ts    # checkpoint / MEMORY 模板 + 段预算
│   ├── write.ts            # ② remember_fact / save_checkpoint / note 的 execute
│   ├── search.ts           # ④ memory_search 工具 + BM25 + scope 过滤 + 地板
│   ├── commands.ts         # A：/checkpoint /remember 注册
│   ├── consolidate.ts      # ⑤ /dream /distill 编排
│   ├── logger.ts           # M5：诊断日志（client.app.log，容错 + 级别门控）
│   └── metrics.ts          # M5：使用计数（SQLite memory_metric 表）+ memory_stats
└── test/
    ├── paths.test.ts       # 路径解析 / 穿越防护
    ├── fts-query.test.ts   # 特殊字符不崩、token 化正确
    ├── reconcile.test.ts   # 增量索引 / 删除清理
    ├── search.test.ts      # BM25 排序 / 地板过滤 / scope 隔离
    ├── write.test.ts       # 段合并去重 / 原子写 / 模板渲染
    ├── consolidate.test.ts # /dream /distill 编排 + 软提醒
    ├── logger.test.ts      # M5：级别门控 + 容错（不抛/不阻塞）
    └── metrics.test.ts     # M5：计数累加 / ON CONFLICT / 禁用开关
```

---

## 9. 风险与取舍

| 风险 | 应对 |
|---|---|
| 模型不主动调 `memory_search`（方案 B 死穴） | 工具描述强引导；后续可加**可选**的"轻量注入"开关（项目记忆挂 system 前缀，缓存友好）作为兜底——但默认关闭，保持纯方案 B |
| 模型不主动调写入工具（闸门 B 漏记） | 工具描述明确"何时调用"；用户命令（闸门 A）兜底强制存档 |
| MEMORY.md 随时间膨胀 | 写入时段内去重合并；`/dream` 定期收敛压缩；显式触发本身已大幅减少噪音 |
| 多会话并发写同一项目 MEMORY.md | 原子写（临时文件 + rename）；`/dream` 串行化 |
| FTS5 query 特殊字符崩解析器 | `fts-query.ts` 统一 token 化 + 短语化 |
| SQLite 依赖 | 用 Node 内置 `node:sqlite`（Node 22.5+/24 稳定，含 FTS5），无需安装原生模块；插件运行时为 Node（见 §1.1） |
| 记忆泄漏到无关会话/项目 | 检索 SQL 强制 scope 过滤；路径构建做穿越防护 |

---

## 10. 里程碑

1. **M1 — 能存能搜（最小闭环）** ✅：存储层（paths + index-db + reconcile + fts-query）+ 检索层（memory_search）+ 写入工具 `remember_fact`。验证"agent 记一条、之后能搜到"。
2. **M2 — 完整写入** ✅：`save_checkpoint` + `note` + checkpoint/MEMORY 模板与段合并 + 命令 `/checkpoint` `/remember`。
3. **M3 — 三层晋升** ✅：全局记忆 + 写入时的项目/全局路由。
4. **M4 — 收敛** ✅（v1 简化版）：`/dream`（合并去重晋升）+ `/distill`（工作流沉淀）。当前为最小框架——dream 只读 checkpoint/MEMORY 不读原始会话历史，distill 只产出建议不自动落地。两处均为有意的成本/安全取舍，详见 §6。先跑一段时间收集反馈再决定是否加重。
5. **M5 — 打磨** 🚧（进行中）：配置项 ✅、`/dream` 软提醒 ✅（M4 已做）、**诊断日志 + 使用指标 ✅**（见下）、可选的缓存友好注入兜底（暂不做，待指标反馈再议，见 §6 原则）。

### M5 诊断日志与使用指标

- **日志（`src/logger.ts`）**：走 opencode 自己的日志通道 `client.app.log`（service=`memory`），与 opencode 日志同文件。两条硬保证：①**绝不抛出、绝不阻塞**——fire-and-forget，任何失败（HTTP 错误、无 client）都被吞掉，日志故障不影响工具；②**级别门控**——低于 `log.level` 阈值的条目在做任何事之前丢弃。无 client 时（如单测）退回 `console`。每个工具的 execute 都包了 try/catch：异常先记 `error` 再以友好消息返回，**修掉了此前"插件异常被静默吞掉"的盲区**。
- **指标（`src/metrics.ts`）**：复用插件自建 SQLite 的 `memory_metric` 表（单行单 key 计数），不新增文件。计数项：`remember.{added,updated,duplicate,global}`、`search.{count,zero_hits}`、`checkpoint.saved`、`note.added`、`dream.{run,skip}`、`distill.{run,skip}`。`bump()` 失败同样被吞掉，受 `metrics.enabled` 控制。
- **读取**：新增 `memory_stats` 工具（无参），随时输出累计统计（含检索零命中率），用于"先跑一段时间收集反馈"——例如零命中率偏高提示分词或 `scoreFloor` 需要调。

---

## 附：与 MiMo Code 的能力对照

| 能力 | MiMo（fork 引擎） | 本插件 | 说明 |
|---|---|---|---|
| 三层记忆 + 晋升链 | ✅ | ✅ | 完整保留 |
| FTS5 + BM25 检索 | ✅ | ✅ | 完整保留 |
| agent 按需检索 | ✅ | ✅ | 完整保留 |
| 记忆写入 | 后台 subagent 自动写 | 显式工具 + 命令 | **取舍**：换稳定性与信噪比 |
| token 阈值自动触发 | ✅ | ❌ | 主动放弃（最不稳定一环） |
| 上下文无损重建（换页） | ✅ | ❌ | 引擎够不着，必须 fork |
| dream / distill | ✅ 自动定时 | ✅ 命令触发 | 不做自动定时 |
| 写入时跑后台 LLM | ✅ | ❌（仅 dream/distill 跑） | 简化：内容由主 agent 当场产出 |
