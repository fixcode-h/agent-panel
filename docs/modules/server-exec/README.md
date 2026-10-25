# server-exec：真实调用本机 CLI

- status: inferred
- source_paths: `server/exec/`
- entry: `server/exec/runner.ts`
- analyzed_at: 2026-10-24

## 职责

- 调用 CLI：按 `shared/clis` 里的定义拼参数、传任务、续接会话、选模型和思考强度（`server/exec/invoke.ts`、`server/exec/runner.ts`）。Agent 的回复语言规则也在这里交给 CLI：有系统提示词参数的（Claude Code、Codex、Pi）跟角色说明一起放进系统提示词，Command Code 用 `server/exec/prompt-lang-mod.ts` 生成的 `--mod` 追加，其余写在任务描述里并在末尾再提醒一次；细节见 [cli-config.md](../../cli-config.md) 的「回复语言」。
- 进程管理：启动、结束整个进程树（Windows 用 `taskkill /T /F`）、超时和孤儿进程回收、进程占用统计（`server/exec/process.ts`、`server/exec/orphans.ts`、`server/exec/proc-stats.ts`）。
- 进程与内存按对话子树归属：每个登记的 CLI 进程带 `owner`（`taskId` / `rootTaskId` / `title`）。进程列表、关闭、清理、AI 清理建议和内存曲线都只认 `owner.taskId` 落在「当前任务 + 它的全部后代」里的登记（子树由 `shared/run-usage.ts` 的 `subtreeTaskIds` 算；`cleanableClis` 的 `taskIds`、`summarize` 的任务 id 集合都是这个口径）。所以打开子对话只看自己这一支，看不到父对话和兄弟。面板 server 自身的 RSS 不属于任何对话，不计入对话合计。历史采样同时写 `roots`（旧的整树口径）和 `tasks`（`aggregateByTask` 按 `owner.taskId` 聚合）：新样本按 `tasks` 求和。只有 `roots` 的旧样本，用当前任务 id 集合去匹配 roots 的 `root` 键（`server/exec/proc-stats.ts` 的 `summarize` / `sampleRss`）：当前是根对话时能还原整棵树；子对话的 id 对不上 roots 键，返回 `null`（未知）而不是 0——否则该点会和升级后的点混成一条 0 起步的曲线，趋势被误判成持续上涨；旧样本 roots 为空（当时整台机器没有任何登记的进程）时才返回 0。
- API 并发上限：API 设置里的 `maxConcurrent`（0 不限制，默认 0）按 API 计同时在请求模型的 CLI 调用。所有调用都从 `runner.ts` 的 `gatedRunAgent` 进，先拿名额（`server/api-slots.ts`，满了先到先得排队，排队时对话 / 步骤上带 `apiWait`，对话仍算在运行、能停止），结束时还。停在等下一句（`waitNext`）、工具里等子任务或主 Agent（引擎的 `yieldSlot`）时让出名额，接着干之前再拿回；占着名额等子任务会和排队的子任务互相等死。预热不占名额，等到第一句再拿。账号登录的 CLI 不受限。
- 输出解析：各 CLI 的结构化输出转成面板的流式事件（`server/exec/parsers.ts`）。
- 常驻双向协议：Claude Code、Codex 的专用适配器和统一的 RPC 会话引擎（`server/exec/rpc/`），插话、中断、结束判断都在这里。
- 改动统计：对比任务开始时的 `git diff --numstat` 快照算出改动文件（`server/exec/git.ts`）。
- 子对话隔离：`childIsolation = worktree` 时在独立 worktree 里执行并按 git merge 合回（`server/exec/worktree.ts`）；`claim` 模式的文件认领在 `server/claims.ts`。

## 入口

`server/exec/runner.ts`：由 `server/tasks.ts` 在节点执行时调用，宿主决定「怎么调用一个 Agent」，执行引擎本身在 `shared/engine.ts`。

## 依赖

`shared/clis.ts` 的 CLI 定义（**不按 CLI 名字写分支**，差异一律做成定义字段）、`cross-spawn`。
协议适配器的样本输出放在 `server/exec/fixtures/`，格式说明见该目录下的 README。

## 回归验证

- `npm run test:unit`（`server/exec/*.test.ts`：解析、进程、RPC、孤儿进程、worktree、停止等）
- 会话按目录存：`shared/task-session-dir.test.ts` 的「sameDir：Windows 路径的大小写、分隔符、末尾斜杠都不影响判定」「sessionMoved：会话在别的目录里就算搬过」「没记过目录的会话不判为搬过」「对话在没有新字段时退回共用的 sessionDir」「新字段按会话分别记，优先于对话共用的 sessionDir」。改会话续接时特别注意：`resume` 的目录判定必须对子任务也生效，不能写成 `chat &&` 短路（见 `bugs/sub-session-other-project.md`）。
- 进程与内存口径：`server/exec/proc-stats.test.ts` 的「按任务汇总」「进程归属：只取当前子树任务的登记，祖先、兄弟和无归属的面板动作都不算」「清理白名单：只看当前对话及附属的任务登记」「内存历史：新采样按任务分开记，子对话只加自己这一支」「内存历史：旧样本只有根任务聚合时，子对话是未知而不是 0（不制造 0 起步的假曲线）」「内存历史：合计只算这个对话的 CLI，面板 server 单独给出」；`server/task-memory.test.ts` 的「会话内存分析接口：子对话的采样只加自己这一支，不算父对话和兄弟」；任务树本身在 `shared/run-usage.test.ts`（父/子/孙、兄弟、无关任务、数据里成环）。
- API 并发上限：`server/api-slots.test.ts`（排队顺序、停止离队、调大上限放行、让出拿回不多占）；`scripts/e2e/07-local.mjs` 的账号和 API 一步里，名额是 1 时第二个对话排队、排队时停止不再启动、对话和它派的两个子任务同用一个 API 不会互相等死。
- 改了执行流程、停止、续跑或 worktree 合并后跑 `npm run test:e2e`（用 `scripts/fake-cli` 模拟各 CLI，Windows 上在 WSL 里）

## 待确认

- 新增一种 RPC 协议：能只写 `shared/clis/*.json` 的就不要加适配器；必须加时先看 `server/exec/rpc/spec.ts` 和 `docs/cli-config.md` 的接入检查清单（待确认）。
