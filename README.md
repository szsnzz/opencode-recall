# opencode-recall

opencode 的长期记忆系统：**显式写入** + **按需 FTS5 检索**，三层（会话 / 项目 / 全局）记忆带晋升链。

记忆不靠后台静默触发，而是由 agent/用户显式发起——存下来的都是"被判断为值得记"的高信号条目。检索由 agent 主动发起，**不注入上下文**，对 prompt 缓存零影响。

以 **opencode skill** 形式交付：一个零运行时依赖的 Node CLI（只用内置 `node:sqlite`）+ 一份 `SKILL.md`。agent 在合适时机调用 CLI 写入/检索记忆。

> 详细架构见 [DESIGN.md](./DESIGN.md)。

## 为什么是 skill 而非 plugin

本项目最初做成 opencode plugin，但 opencode **桌面版**在 Windows 上有一个依赖安装器 bug（[官方 issue #30197](https://github.com/anomalyco/opencode/issues/30197) 等）：启动时会尝试安装 `@opencode-ai/plugin@local` 这个不存在的版本并失败，导致**任何 plugin 都无法加载**，与具体插件无关。

skill 不经过该安装器（opencode 直接读取 skill 目录、由 agent 用 shell 调用脚本），从机制上绕开了这个 bug，且零依赖、无需联网。plugin 版代码仍保留在仓库中（见 `src/index.ts`），待上游修复后可继续使用。

## 运行环境要求

- **Node.js ≥ 22.5**（依赖内置 `node:sqlite`，含 FTS5）。opencode 桌面版满足此要求。
- 更旧的 Node 缺少 `node:sqlite`，CLI 会报错。

## 安装

把 skill 放进 opencode 的 skills 目录即可（全局或项目级）：

```
~/.config/opencode/skills/opencode-recall/
├── SKILL.md
├── cli.mjs
└── lib/        # 编译后的后端
```

从源码安装：

```bash
git clone https://github.com/szsnzz/opencode-recall
cd opencode-recall
npm install
npm run build:skill          # 把 src 编译进 skill/lib
# 复制到 skills 目录（Windows PowerShell）
Copy-Item -Recurse skill "$HOME\.config\opencode\skills\opencode-recall"
# macOS / Linux
# cp -r skill ~/.config/opencode/skills/opencode-recall
```

装好后 opencode 会自动发现该 skill。当你说"记住…/存档进度/回忆一下之前…"时，agent 会按 `SKILL.md` 调用 `cli.mjs` 完成读写。

## 配置（可选）

CLI 从项目根的 `.opencode/memory.json` 读取配置。全部字段都有默认值，文件可省略：

```json
{
  "enabled": true,
  "root": "~/.config/opencode/memory",
  "search": { "scoreFloor": 0.15, "limit": 10 },
  "dream":   { "intervalDays": 7  },
  "distill": { "intervalDays": 30 },
  "log":     { "level": "info" },
  "metrics": { "enabled": true }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭记忆功能 |
| `root` | `~/.config/opencode/memory` | 记忆根目录。设为项目内路径（如 `./_memory_data`）可实现项目隔离 |
| `search.scoreFloor` | `0.15` | 相对分数地板：保留 ≥ 最高分 × 该值的结果（首条总是保留） |
| `search.limit` | `10` | `search` 默认返回条数 |
| `dream.intervalDays` | `7` | 收敛软提醒间隔（`0` = 不限制）。不自动运行 |
| `distill.intervalDays` | `30` | 提炼软提醒间隔 |
| `log.level` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `metrics.enabled` | `true` | 记录使用计数，用 `stats` 查看 |

环境变量覆盖：`OPENCODE_MEMORY_ROOT=<dir>`、`OPENCODE_MEMORY_DISABLED=1`。

## CLI 子命令（agent 通过 SKILL.md 调用）

```
node cli.mjs <子命令> --project <项目根> [其它参数]
```

| 子命令 | 作用 |
|---|---|
| `remember` | 写入一条跨会话的持久事实/规则/决策到项目记忆（`--global` 写全局） |
| `checkpoint` | 存档会话工作状态（意图、下一步、涉及文件、发现、决策……）到会话检查点 |
| `note` | 追加一条简短笔记到会话草稿本 |
| `search` | 按需检索项目/全局/会话记忆（FTS5 + BM25，支持中文子串），返回高信号片段 |
| `stats` | 查看使用统计（写入/检索各项计数，含检索零命中率） |
| `dump` | 导出本项目全部记忆，供 agent 端做收敛(dream)/提炼(distill) |

各子命令的完整参数见 [`skill/SKILL.md`](./skill/SKILL.md)。

> **收敛 / 提炼**：原 `/dream`、`/distill` 改为 `dump` + agent 端处理——CLI 把记忆全文交给 agent，由 agent 合并去重、晋升持久知识、或识别可沉淀的工作流。这是有意的成本/安全取舍，见 DESIGN.md §6。

## 记忆模型：两个独立维度

理解 opencode-recall 的关键是分清**两个互不相干的维度**——很多困惑来自把它们混在一起。

### 维度一：记忆的层级（scope）

记忆分三层，决定**谁能检索到它**：

| 层级 | 怎么写入 | 谁能检索到 | 典型用途 |
|---|---|---|---|
| **global（全局）** | `remember --global` | **所有项目** | 跨项目通用的规则/偏好，如提交信息规范、个人编码习惯 |
| **project（项目）** | `remember`（默认，不加 `--global`） | **仅同一项目** | 该项目的架构决策、踩过的坑、持久知识 |
| **session（会话）** | `checkpoint` / `note` | **仅当前会话**（检索默认带上） | 当前会话的工作状态、零散备忘 |

项目身份由**项目根绝对路径的 sha256 哈希前 12 位**（`projectId`）决定：同一个项目路径 → 同一个 id → 共享同一份 `projects/<projectId>/MEMORY.md`。这就是为什么 `remember`（默认）写出来的东西落在 `projects/<哈希>/` 下——它是 **project 级**，按项目自动隔离，与"记忆库放哪"无关。

> 检索默认 `scope=all`，会同时覆盖 全局 + 当前项目 + 当前会话，但**绝不**泄漏其它项目或其它会话的记忆。

### 维度二：记忆库的物理位置（root）

`root` 配置决定上述三层结构**整体存在磁盘的哪里**：

- **默认共享根**（不配 `memory.json`）：所有项目的记忆都汇到 `~/.config/opencode/memory/`，靠 `projects/<projectId>/` 哈希子目录互不干扰。统一管理、跨项目检索方便。
- **项目内独立根**（配 `{"root": "./_memory_data"}`）：记忆物理上待在项目目录里，可随 git 走、随项目迁移、彻底物理隔离。

两个维度正交：无论 `root` 放哪，内部永远是 global / projects / sessions 三层结构。

### 磁盘布局

```
<root>/                               # 默认 ~/.config/opencode/memory，或项目内 ./_memory_data
├── global/MEMORY.md                  # 全局：跨项目偏好/规则（需 --global 写入）
├── projects/<projectId>/MEMORY.md    # 项目：跨会话长期知识（projectId = 项目路径哈希）
├── sessions/<sessionId>/
│   ├── checkpoint.md                 # 会话：当前状态
│   └── notes.md                      # 会话：草稿笔记
└── index.db                          # 自建 SQLite FTS5 索引（不碰 opencode 库）
```

## 开发

```bash
npm run typecheck     # tsc --noEmit
npm test              # node --test（运行时与生产一致）
npm run build         # 编译插件版到 dist/
npm run build:skill   # 编译后端到 skill/lib/（skill 分发用）
```

## License

MIT
