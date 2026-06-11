# 安装与踩坑（opencode-memory）

把本插件装进一个 opencode 项目的完整步骤，以及联调时踩出来的坑与排查方法。
架构设计见 [`DESIGN.md`](./DESIGN.md)；本文只讲“怎么装、为什么这么装、出问题怎么查”。

> 适用前提：**opencode 桌面版**，插件运行时为 **Node.js v22.5+（建议 v24）**。
> 关键运行时约束见 DESIGN.md §1.1，本文的每一步都是为了满足那些约束。

---

## 1. 安装步骤

插件用 opencode 的本地插件机制加载（`.opencode/plugins/` 下的 `*.ts`/`*.js` 自动发现）。
目标项目根目录记为 `<PROJECT>`。

### 1.1 放置插件代码

两种方式，二选一：

**A. 跨目录引用（开发期推荐）** — 插件源码留在它自己的仓库，项目里只放一个桥接文件：

`<PROJECT>/.opencode/plugins/memory-bridge.ts`
```ts
// 把源码路径换成你本机的 opencode-memory 仓库路径
export { MemoryPlugin } from "file:///D:/CODE3/opencode-memory/src/index.ts";
```

**B. 直接拷贝** — 把 `src/` 整个拷进 `<PROJECT>/.opencode/plugins/opencode-memory/`，
桥接文件改成相对路径 `export { MemoryPlugin } from "./opencode-memory/index.ts";`。

> 导出形态：具名导出（`export { MemoryPlugin }`）和 `export default` opencode 都认。
> 之前怀疑过 default 不行，**那是错的**——真正的拦路虎是依赖没装上（见 §1.2）。

### 1.2 声明并预装插件依赖（**关键**，否则工具不注册）

`<PROJECT>/.opencode/package.json`
```json
{
  "name": "<project>-opencode-plugins",
  "private": true,
  "type": "module",
  "dependencies": {
    "@opencode-ai/plugin": "1.17.3"
  }
}
```

然后在 `<PROJECT>/.opencode/` 下预装一次：
```bash
cd <PROJECT>/.opencode
bun install   # 或 npm install
```

为什么必须手动预装：桌面版会自己尝试装 `@opencode-ai/plugin`，但它把自身版本号
（`local`）当成插件包版本去 npm 找 `@opencode-ai/plugin@local`——不存在，安装失败。
失败是 warning 不阻塞，但插件 import 这个包时找不到 → 整个插件静默加载失败、工具一个都不注册。
预装到 `.opencode/node_modules` 后，import 能解析，问题消失。
`"type": "module"` 用来消除 Node 对 `.ts` 的 ESM 重解析告警。

### 1.3 配置文件

`<PROJECT>/.opencode/memory.json`（opencode **不**解析此文件，插件自己读）：
```json
{
  "enabled": true,
  "root": "<PROJECT>/_memory_data",
  "search": { "scoreFloor": 0.15, "limit": 10 },
  "log": { "level": "info" },
  "metrics": { "enabled": true }
}
```

- `root` 省略时默认 `~/.config/opencode/memory`（全局共享）。要项目隔离就显式指定。
- `log.level`：`debug` | `info` | `warn` | `error`，默认 `info`。日志写入 opencode 自己的日志文件（service=`memory`），排查问题时可调到 `debug`。
- `metrics.enabled`：默认 `true`，记录写入/检索/收敛的使用计数；用 `memory_stats` 工具随时查看。
- 环境变量覆盖：`OPENCODE_MEMORY_ROOT=<dir>`、`OPENCODE_MEMORY_DISABLED=1`。
- **不要**把这些配置塞进 `opencode.json`：opencode 严格校验该文件，未知顶层 key（如 `memory`）
  会报 `Unrecognized key` 并使整个会话起不来。

### 1.4 斜杠命令（可选）

插件**无法**自己注册斜杠命令，用 opencode 原生命令文件。放在 `<PROJECT>/.opencode/commands/`：

`checkpoint.md`
```markdown
---
description: 立即生成并存档一份完整的会话检查点
---
请基于当前会话上下文，调用 save_checkpoint 工具存档检查点……（按需填写引导语）
```

`remember.md`
```markdown
---
description: 把一条事实快速写入项目记忆
---
请调用 remember_fact 工具，把下面这条事实写入项目记忆（section 用 durable_knowledge）：

$ARGUMENTS

写入后用一句话确认即可。
```

> 原生命令只能“发一段 prompt 给 agent”，所以 `/remember`、`/checkpoint` 是**引导 agent 去调工具**，
> 比直接写盘多一次 LLM 往返，但走的是受支持的稳定路径。

### 1.5 重新加载项目验证

重载 `<PROJECT>` 后：
1. 让 agent 列工具，应能看到 `remember_fact` / `memory_search` / `save_checkpoint` / `note` / `memory_stats`。
2. 调 `remember_fact` 记一条，再 `memory_search` 搜回来。
3. 检查 `<PROJECT>/_memory_data/` 出现 `projects/<id>/MEMORY.md`、`index.db` 等。

---

## 2. 踩坑速查表

按“现象 → 根因 → 解法”整理，全部为联调实测。

| 现象 | 根因 | 解法 |
|---|---|---|
| 插件面板能看到插件，但**工具一个都没有** | `@opencode-ai/plugin@local` 安装失败 → 插件 import 失败、静默挂掉 | §1.2 预装依赖到 `.opencode/node_modules` |
| 工具仍然没有，且只有用到 SQLite 的插件挂 | 运行时是 **Node 不是 Bun**，`bun:sqlite` 不存在 | 存储层已改用 `node:sqlite`（`src/storage/sqlite.ts`）；不要再引入任何 `Bun.*` / `bun:*` |
| 插件加载抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node type-stripping 不支持 TS 参数属性 / `enum` / `namespace` | 改写法：参数属性拆成显式字段赋值；类型导入用 `import type` |
| 整个会话起不来，报 `Unrecognized key` | 把 `memory` 配置写进了 `opencode.json` | 配置移到独立的 `.opencode/memory.json` |
| 数据落盘了，但写到 `~/.config/opencode/memory` 而非项目目录 | 非 git 目录时 `worktree="/"`，projectRoot 算成了根 | 已用 `pickProjectRoot()`：worktree 是真实路径才用，否则退回 `directory` |
| `/checkpoint`、`/remember` 找不到 | 插件不能注册命令；曾试图用 `config` hook 注入，不成立 | 用原生命令文件 `.opencode/commands/*.md`（§1.4） |
| `bun test` 报 `No such built-in module: node:sqlite` | bun 没有 `node:sqlite` | 用 Node 跑测试：`npm test` → `node --experimental-strip-types --test "test/*.test.ts"` |

---

## 3. 诊断技巧

- **看加载日志**：`~/.local/share/opencode/log/opencode.log`。
  搜 `background dependency install failed` / `level=ERROR`。注意插件加载异常常被静默吞掉，
  日志里可能只有 install 的 warning，需要结合“哪些工具没注册”反推。
- **运行时探针**：临时放一个零依赖插件，工具里打印
  `typeof Bun`、`process.versions.node`、试 `import("node:sqlite")`，就能确认运行时与能力。
- **路径探针**：在插件入口把 `project` / `directory` / `worktree` 写到一个固定文件，
  能直接看到 opencode 实际传入的路径（非 git 项目下 `worktree` 会退化成 `/`）。
- **贴近真实运行时验证**：本机用
  `node --experimental-strip-types <脚本>.ts` 跑，比 `bun <脚本>` 更接近桌面版的加载方式
  （Node + type-stripping）。

---

## 4. 本仓库的开发命令

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --experimental-strip-types --test "test/*.test.ts"
```

测试基于 `node:test`；`test/helpers/bun-test-shim.ts` 提供了 `bun:test` 风格的
`describe/test/expect` 兼容层，所以测试体仍是熟悉的 `expect(x).toBe(...)` 写法。
