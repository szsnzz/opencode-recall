# opencode-recall

opencode 的长期记忆插件：**显式写入** + **按需 FTS5 检索**，三层（会话 / 项目 / 全局）记忆带晋升链。

记忆不靠后台静默触发，而是由 agent 的工具调用或用户命令显式发起——存下来的都是"被判断为值得记"的高信号条目。检索走方案 B（agent 主动调 `memory_search`），**不注入上下文**，对 prompt 缓存零影响。

> 详细架构见 [DESIGN.md](./DESIGN.md)；本地开发与排查见 [INSTALL.md](./INSTALL.md)。

## 运行环境要求

- **Node.js ≥ 22.5**（插件运行时；依赖 Node 内置 `node:sqlite`，含 FTS5）。opencode 桌面版满足此要求。
- 用更旧的 Node 会因缺少 `node:sqlite` 而静默加载失败。

## 安装

推荐**手动下载到本地**再引用——你掌握下载时机，opencode 启动时不必联网。

1. 到 [Releases](https://github.com/szsnzz/opencode-recall/releases) 下载最新版本的 `opencode-recall-<version>.tgz`，存到本地任意固定位置，例如 `D:/opencode-plugins/opencode-recall-0.1.0.tgz`。
2. 把该 **tarball 的绝对路径**填进项目（或全局）`opencode.json` 的 `plugin` 字段：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["D:/opencode-plugins/opencode-recall-0.1.0.tgz"]
}
```

opencode 启动时会从这个本地 tarball 安装插件及其依赖（缓存在 `~/.cache/opencode/node_modules/`）。无需手动建 `package.json` 或桥接文件。

> **路径写法**：用**绝对路径**，正斜杠 `/`（如 `D:/...`）或反斜杠都可，但**不要**用 `file:///` 前缀——底层的 Bun 不接受该形式。
> macOS / Linux 同理：`"/Users/you/opencode-plugins/opencode-recall-0.1.0.tgz"`。

> **升级**：下载新版本 tarball，把 `plugin` 里的路径换成新文件即可。

<details>
<summary>备选：直接引用 Release 远程 URL（启动时联网下载）</summary>

如果不介意 opencode 启动时联网，也可以直接填 Release 直链：

```json
{ "plugin": ["https://github.com/szsnzz/opencode-recall/releases/download/v0.1.0/opencode-recall-0.1.0.tgz"] }
```

</details>

## 配置（可选）

插件从项目根的 `.opencode/memory.json` 读取配置（opencode 不解析此文件，所以**不要**把这些放进 `opencode.json`——它会因未知字段报错）。全部字段都有默认值，文件可省略：

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
| `enabled` | `true` | 关闭插件 |
| `root` | `~/.config/opencode/memory` | 记忆根目录。设为项目内路径（如 `./_memory_data`）可实现项目隔离 |
| `search.scoreFloor` | `0.15` | 相对分数地板：保留 ≥ 最高分 × 该值的结果（首条总是保留） |
| `search.limit` | `10` | `memory_search` 默认返回条数 |
| `dream.intervalDays` | `7` | `/dream` 软提醒间隔（`0` = 不限制）。不自动运行 |
| `distill.intervalDays` | `30` | `/distill` 软提醒间隔 |
| `log.level` | `info` | `debug` \| `info` \| `warn` \| `error`，写入 opencode 日志（service=`memory`） |
| `metrics.enabled` | `true` | 记录使用计数，用 `memory_stats` 查看 |

环境变量覆盖：`OPENCODE_MEMORY_ROOT=<dir>`、`OPENCODE_MEMORY_DISABLED=1`。

## 工具（agent 可调用）

| 工具 | 作用 |
|---|---|
| `remember_fact` | 写入一条跨会话的持久事实/规则/决策到项目记忆（`global: true` 写全局） |
| `save_checkpoint` | 存档会话工作状态（意图、下一步、涉及文件、发现、决策……）到会话检查点 |
| `note` | 追加一条简短笔记到会话草稿本 |
| `memory_search` | 按需检索项目/全局/会话记忆（FTS5 + BM25，支持中文子串），返回高信号片段 |
| `memory_stats` | 查看使用统计（写入/检索/收敛各项计数，含检索零命中率） |

## 命令（可选）

斜杠命令需要你在项目里放对应的命令文件 `.opencode/commands/<name>.md`：

| 命令 | 作用 |
|---|---|
| `/remember <文本>` | 快速把一条事实写入项目记忆（确定性写入，闸门 A 兜底） |
| `/checkpoint` | 引导 agent 调 `save_checkpoint` 存档完整检查点 |
| `/dream` | 合并去重记忆、晋升持久知识（需 LLM；带软提醒） |
| `/distill` | 识别重复工作流并给出沉淀建议（需 LLM） |

> `/dream`、`/distill` 当前为最小框架版（v1）：dream 只读已浓缩的 checkpoint/MEMORY，distill 只产出建议不自动落地。这是有意的成本/安全取舍，见 DESIGN.md §6。

## 记忆存储布局

```
<root>/
├── global/MEMORY.md                  # 全局：跨项目偏好/规则
├── projects/<projectId>/MEMORY.md    # 项目：跨会话长期知识
├── sessions/<sessionId>/
│   ├── checkpoint.md                 # 会话：当前状态
│   └── notes.md                      # 会话：草稿笔记
└── index.db                          # 插件自建 SQLite FTS5 索引（不碰 opencode 库）
```

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（运行时与生产一致）
npm run build       # 编译到 dist/
```

## License

MIT
