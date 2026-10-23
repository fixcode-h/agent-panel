---
paths: server/exec/worktree.ts, server/exec/worktree.test.ts
---

# 独立工作目录（worktree）

## 依赖各用一份，不能链接共享

- 规则：`server/exec/worktree.ts` 准备独立目录时，`node_modules`（以及 `.venv` / `venv` / `vendor`）要整份复制过去，不建 junction / 符号链接，也别用硬链接——跨分卷用不了，同分卷时 npm 原地重写 `node_modules/.package-lock.json` 会顺着 inode 改到项目那一份。子对话补依赖只在自己的目录里装。
- 起因：2026-10 的事故，某个子对话在自己的目录里跑安装，npm 按那个分支的 `package.json` 修剪依赖，剪掉的正是链接过去的共用真目录：主工作区 `node_modules` 从满装变成 0 项、`.bin` 也没了，几个对话的验证同时失败。
- 成本：596MB / 27k 个文件跨分卷复制约 13 秒（一次性），比事后依赖被整片剪掉强。
- 防线：`server/exec/worktree.test.ts` 里「依赖隔离」的三个用例。

## 共用目录的依赖坏了要立刻说清

- 规则：开独立目录时用 `missingDeps()` 对 `package.json` 的声明逐个查 `node_modules`，缺了就在面板日志里用 `log.error` 写清哪个目录、缺哪些包、怎么补（在一份完整的目录里 `npm ci --include=dev`，或把完好的 `node_modules` 整份复制回来），不要留给后面每条命令各报一句「找不到模块」。
- 起因：同一次事故里，几个对话的 typecheck / 测试都只报「找不到模块」，看不出是共用依赖被剪掉了。
- 防线：`server/exec/worktree.test.ts` 里 `missingDeps` 的用例。

## Windows 和 WSL 共用一份依赖时，两边的入口都要在

- 规则：同一份 `node_modules` 给 Windows 和 WSL 一起用时，`.bin` 要同时有 Linux 的 shim（或符号链接）和 Windows 的 `.cmd`；平台原生包两边都得装：`@typescript/typescript-win32-x64`、`@oxlint/binding-win32-x64-msvc`、`@rolldown/binding-win32-x64-msvc`、`@esbuild/win32-x64`、`@tailwindcss/oxide-win32-x64-msvc`、`lightningcss-win32-x64-msvc`。补的时候用 `npm pack` 下载再解压（见共享依赖那条教训），不要跑 `npm i`。
- 起因：2026-10 恢复主工作区依赖时，把 WSL 里装的那份整份复制回来，Windows 上 `npx tsc` / `npx oxlint` / `npx vite` 全报缺平台包，`.bin` 里只有 Linux 的符号链接。
- 防线：人工——恢复后在两个环境各跑一次 `npx tsc --version && npx oxlint --version && npx vite --version`。
