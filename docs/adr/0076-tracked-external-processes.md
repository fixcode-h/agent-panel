# ADR 0076：外部进程统一入口（进孤儿登记、统一结束整棵树）

状态：已接受 · 2026-11-23

## 背景

「可统一能力盘点」第 8 项：面板起 CLI 有 `server/exec/process.ts`（`runProcess`、杀进程树、孤儿登记），但 UE 插件起 Build.bat / UBT、Lua 编译时自己 `spawn`，结束时 5 个文件各自调 `taskkill /T /F`、各写一份报错和等退出。面板被强杀后这些进程不在孤儿登记里，下次启动没人清，只能编译前用 PowerShell 扫进程补救（2026-11-20 编译进程残留卡在 `-WaitMutex`）。

## 决策

1. `server/exec/tracked.ts`（开放给插件）：
   - `spawnTracked(command, args, { cwd, source, title, tag?, shell?, detached?, … })`：起进程并登记进 `orphans.ts` 的孤儿登记，退出时撤掉。
   - `stopTree(pid, { waitMs? })`：结束整棵进程树并等它真的退出，结束不了时把系统原话放在 `error` 里。
2. 孤儿登记加 `extra: { tag, source, title }`：这类进程的命令行没有面板痕迹（`cli-run` 目录、panel MCP 参数），清理时按登记的 `tag`（默认是命令本身）认——现在那个 pid 的命令行里还带着它才动手，pid 被复用的不碰。CLI 照旧按面板痕迹认（`stillOurs`）。
3. UE 插件的编译和安装作业（`spawnJob`）、Lua 编译、取消编译、强制结束挡路的编辑器和旧编译、强制关闭编辑器都改走这两个函数。

候选方案：

- **SDK 加 `ctx.procs.spawn`**：暂不做。开放模块已经能让插件直接用同一份，不用为此升插件接口版本。
- **让插件改用 `runProcess`**：不做。它是给 CLI 对话设计的（stdin 写任务、空闲检测），插件要自己接输出、用 shell 跑 .bat，套过来反而要绕。

## 影响

- 插件和面板里起「不是 CLI 对话」的长进程一律 `spawnTracked`，结束一律 `stopTree`，不再自己调 taskkill（AGENTS.md「先找能共用的」）。
- 优雅关闭编辑器（不带 /F 的 taskkill，给窗口发关闭消息）是另一种动作，仍在 UE 插件里。
- 视频插件的 ffmpeg 等短命令还没迁，后面逐个接。
