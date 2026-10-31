---
paths: server/exec/worktree.ts, server/exec/worktree.test.ts
---

# 独立工作目录（worktree）

## 依赖只放一份在 worktrees/ 下，靠目录向上查找

- 规则：`server/exec/worktree.ts` 的 `ensureSharedDeps` 把项目的 `node_modules` 复制到 `<数据目录>/worktrees/<项目名>-<路径哈希>/node_modules`（按 git 主仓库根分组，同一个项目的子对话共用），每个独立目录里**不放 `node_modules`、不建任何链接**：Node / npm 会沿目录向上解析到这一份，`npm run` 的 PATH 也包含祖先的 `node_modules/.bin`。只有 `package-lock.json`（没有就 `package.json`）变了才重新复制；用 `mkdir node_modules.lock` 抢锁、复制期间每 2 秒更新锁的时间作心跳（进程被杀后别人 15 秒内接手，不用干等）；源目录和 lock 都按项目根读（子对话从父对话的独立目录里开时那里没有 `node_modules`）。`.venv` / `venv` / `vendor` 按自己的路径找依赖，仍然各复制一份。
- 换装不能「先删旧的再改名」：删到一半被占用会留下残缺的一份，同项目的所有子对话都缺包。正确顺序是「旧目录改名挪开 → 新目录改名进来 → 删旧的」，改名失败时把旧的放回去，任何时刻共用那份要么完整旧版、要么完整新版。
- 为什么不是链接：2026-10 的事故里子对话的 `node_modules` 是指向项目那份的 junction，npm 按那个分支的 `package.json` 修剪时删掉的正是项目里的真目录（主工作区从满装变成 0 项）。共用真目录 + 祖先解析没有链接，子对话里 `npm install` 的 prefix 是自己的 `package.json`，装的东西写到它自己目录下，剪不到共用这份。
- 成本（本机 682MB / 约 2.7 万文件）：改动前每个子对话 11–12 秒、696MB；改动后第一次约 10 秒，之后每个约 1 秒，独立目录只占 15MB。
- 不要做：在共用目录里跑 `npm install` / `npm ci` / `npm prune`（会修剪到同项目的所有子对话）；`sweepWorktrees` 里把项目分组目录下的 `node_modules`、`node_modules.lock` 或复制用的临时目录当残留删掉；多个项目共用同一个位置（后开的项目会把前一个的依赖换掉）。
- 防线：`server/exec/worktree.test.ts` 的「依赖共用」五个用例（独立目录不复制、只复制一次、lock 变化才刷新、并发开不互相踩、不同项目各一份）和「守护清理不会清掉共用依赖」。

## 共用目录的依赖坏了要立刻说清

- 规则：开独立目录时用 `missingDeps()` 对 `package.json` 的声明逐个查「从该目录向上找到的那份 `node_modules`」，缺了就在面板日志里用 `log.error` 写清哪个目录、缺哪些包、怎么补（在一份完整的目录里 `npm ci --include=dev`，或把完好的 `node_modules` 整份复制回来），不要留给后面每条命令各报一句「找不到模块」。
- 起因：同一次事故里，几个对话的 typecheck / 测试都只报「找不到模块」，看不出是共用依赖被剪掉了。
- 防线：`server/exec/worktree.test.ts` 里 `missingDeps` 的用例。

## 独立目录要有人收：删除失败上报，残留目录守护清理

- 规则：`releaseWorktree` 删除失败时**返回原因、不抛错**（`server/tasks/children.ts` 的 `completeChild` 会把抛错当成「回收完成」吞掉），任务因此不会被标成干净回收，下一轮还会再试；`sweepWorktrees` 在启动时和每小时扫一遍 `worktrees/`：git 注册表外的残留直接清，注册表内要「改动都已合回原分支（dirty=0、ahead=0）+ 任务已结束（resolved / archived / status done、stopped）」才清，有未提交改动、没合回的提交、还在跑（working / awaitingUser / prewarming）的一律不碰；`AGENT_PANEL_KEEP_WORKTREES=1` 启动时只扫不删。
- 起因：2026-10 本机 `git worktree list` 有 16 个、其中 3 个已合并且无改动却永久残留（父对话结束、面板重启后没人再触发 `advanceChildTo`），另有 2 个目录已不在注册表里；同时 `wipe` 用 `.catch(() => {})` 吞掉删除失败、`releaseWorktree` 照样返回空串，任务被标成干净回收、目录留在磁盘上没人知道。
- 防线：`server/exec/worktree.test.ts` 的「守护清理」四条用例（注册表外残留被清 / 已合并且任务结束被清 / 有未合提交或任务在跑不被清 / dry-run 不删）和「删除结果以实际状态为准」用例。

## Windows 和 WSL 共用一份依赖时，两边的入口都要在

- 规则：同一份 `node_modules` 给 Windows 和 WSL 一起用时，`.bin` 要同时有 Linux 的 shim（或符号链接）和 Windows 的 `.cmd`；平台原生包两边都得装：`@typescript/typescript-win32-x64`、`@oxlint/binding-win32-x64-msvc`、`@rolldown/binding-win32-x64-msvc`、`@esbuild/win32-x64`、`@tailwindcss/oxide-win32-x64-msvc`、`lightningcss-win32-x64-msvc`。补的时候用 `npm pack` 下载再解压（见共享依赖那条教训），不要跑 `npm i`。
- 起因：2026-10 恢复主工作区依赖时，把 WSL 里装的那份整份复制回来，Windows 上 `npx tsc` / `npx oxlint` / `npx vite` 全报缺平台包，`.bin` 里只有 Linux 的符号链接。
- 防线：人工——恢复后在两个环境各跑一次 `npx tsc --version && npx oxlint --version && npx vite --version`。
