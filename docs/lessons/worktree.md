---
paths: server/exec/worktree.ts, server/exec/worktree.test.ts, server/exec/worktree-merge.test.ts, server/exec/worktree-test-kit.ts
---

# 独立工作目录（worktree）

## 每个 worktree 创建时复制一份自己的 node_modules

- 规则：`server/exec/worktree.ts` 的 `prepare()` 在新建 / 重建独立目录时调 `ensureWorktreeDeps(dir, repo)`，把项目根的 `node_modules` 复制成 `<独立目录>/node_modules`（真实文件，不建链接）。复制先进 `node_modules.tmp-*`，成功后「旧目录改名挪开 → 新目录改名进来 → 删旧的」；任何文件复制失败都删掉临时目录、不写 marker、返回 failed，不会把半份当成已准备好。副本里的 `.agent-panel-deps.json` 记着按哪份 lock 复制的：项目的 lock 变了、或者目录里还没有副本（旧 worktree），准备时重新复制一份。临时 / 旧副本目录也写进该目录的 `info/exclude`，而且**写在复制之前**（否则复制中途被杀留下的残留还没被忽略，目录会一直算脏、合并门禁和清扫都不敢动），陈旧（10 分钟没动）的临时目录下次准备时清掉；继续一个已有目录（`ensureWorktree` 早返回）时也检查 marker，缺依赖就补一份。`.venv` / `venv` / `vendor` 同样各复制一份。
- 用户 2026-11-02 的决定：不再共用一份，**每个 worktree 各一份**；在 A 里 `npm install` / 改依赖不影响 B 和项目主目录，两边各有自己的 `.bin` 和平台原生包。
- 为什么不是链接 / 共用：2026-10 事故里子对话的 `node_modules` 是指向项目那份的 junction，npm 按分支 `package.json` 修剪时删掉了项目真目录。复制真实文件只读项目那份、写自己的这份。硬链接也不行：跨分卷用不了，同分卷时 npm 原地重写 `.package-lock.json` 会顺着 inode 改到项目。
- 代价（本机 682MB / 约 2.7 万文件）：每个 worktree 创建多一次约 12–20 秒、约 682MB；删除时随目录一起删。这是用户明确接受的代价，不要为省磁盘改回共用或链接。
- 不要做：在项目分组目录下再建共用的 `node_modules`（旧版本遗留的那份清扫会跳过、不主动删，避免还有旧 worktree 靠祖先解析）；让清扫去删任务目录里的 `node_modules`（它该随任务目录回收）。
- 防线：`worktree.test.ts` 的「独立目录复制一份自己的依赖」「删除独立目录时连同依赖一起删」「并发各一份」「项目没有 node_modules 时跳过」「缺了会补一份」；`worktree-merge.test.ts` 的「A 改依赖不影响 B 和项目」「lock 变了新 worktree 拿新副本」「不同项目各是各的」「临时 / 旧副本目录不进提交」「陈旧临时目录清掉」「删除时清理」「清扫一个目录不动别的依赖」。

## 依赖副本坏了要立刻说清

- 规则：开独立目录时用 `missingDeps(dir)` 对照 `package.json` 逐个查**该目录自己的** `node_modules`，缺了就用 `log.error` 写清哪个目录、缺哪些包、怎么补（在这个目录里 `npm ci --include=dev` 重装；worktree 之间互不影响），不要留给后面每条命令各报「找不到模块」。
- 起因：同一次事故里，几个对话的 typecheck / 测试都只报「找不到模块」，看不出依赖被剪掉了。
- 防线：`worktree.test.ts` / `worktree-merge.test.ts` 的 `missingDeps` 用例。

## 独立目录要有人收：删除失败上报，残留目录守护清理

- 规则：`releaseWorktree` 删除失败时**返回原因、不抛错**（`completeChild` 会把抛错当成「回收完成」吞掉），任务不会被标成干净回收、下一轮还会再试；`sweepWorktrees` 启动时和每小时扫 `worktrees/`：git 注册表外的残留直接清，注册表内要「改动都已合回原分支（dirty=0、ahead=0）+ 任务已结束（resolved / archived / status done、stopped）」才清；有未提交改动、没合回的提交、还在跑的一律不碰；`AGENT_PANEL_KEEP_WORKTREES=1` 启动时只扫不删。
- 起因：2026-10 本机 `git worktree list` 有 16 个、其中 3 个已合并且无改动却永久残留，另有 2 个目录已不在注册表里；同时 `wipe` 吞掉删除失败、`releaseWorktree` 照样返回空串。
- 防线：`worktree.test.ts` 的「守护清理」四条用例（注册表外残留被清 / 已合并且任务结束被清 / 有未合提交或任务在跑不被清 / dry-run 不删）和「删除结果以实际状态为准」。

## 副本按项目那份复制：Windows 和 WSL 都要跑测试时，项目根那份两边包都要有

- 规则：每个 worktree 的 `node_modules` 都从**项目根**复制，所以跨 Windows / WSL 跑测试要求项目根那份 `.bin` 同时有 Linux shim 和 Windows `.cmd`、平台原生包两边都装：`@typescript/typescript-win32-x64`、`@oxlint/binding-win32-x64-msvc`、`@rolldown/binding-win32-x64-msvc`、`@esbuild/win32-x64`、`@tailwindcss/oxide-win32-x64-msvc`、`lightningcss-win32-x64-msvc`（Linux 侧同名 `linux-x64`）。用 `npm pack` 下载再解压补，不要跑 `npm i`（见共享依赖那条教训）；只补某个 worktree 的副本不行。
- 起因：2026-10 把 WSL 里装的那份整份复制回来，Windows 上 `npx tsc` / `npx oxlint` / `npx vite` 全报缺平台包；2026-11 改成每个 worktree 各一份后，这个要求落到项目根那份上。
- 防线：人工——两个环境各跑一次 `npx tsc --version && npx oxlint --version && npx vite --version`。
