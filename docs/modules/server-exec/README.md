# server-exec：真实调用本机 CLI

- status: inferred
- source_paths: `server/exec/`
- entry: `server/exec/runner.ts`
- analyzed_at: 2026-10-24

## 职责

- 调用 CLI：按 `shared/clis` 里的定义拼参数、传任务、续接会话、选模型和思考强度（`server/exec/invoke.ts`、`server/exec/runner.ts`）。Agent 的回复语言规则也在这里交给 CLI：有系统提示词参数的（Claude Code、Codex、Pi）跟角色说明一起放进系统提示词，Command Code 用 `server/exec/prompt-lang-mod.ts` 生成的 `--mod` 追加，其余写在任务描述里并在末尾再提醒一次；细节见 [cli-config.md](../../cli-config.md) 的「回复语言」。
- 进程管理：启动、结束整个进程树（Windows 用 `taskkill /T /F`）、超时和孤儿进程回收、进程占用统计（`server/exec/process.ts`、`server/exec/orphans.ts`、`server/exec/proc-stats.ts`）。
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
- 改了执行流程、停止、续跑或 worktree 合并后跑 `npm run test:e2e`（用 `scripts/fake-cli` 模拟各 CLI，Windows 上在 WSL 里）

## 待确认

- 新增一种 RPC 协议：能只写 `shared/clis/*.json` 的就不要加适配器；必须加时先看 `server/exec/rpc/spec.ts` 和 `docs/cli-config.md` 的接入检查清单（待确认）。
