# Agent 安装很慢、装完找不到命令，且同一时间只能装一个

- 状态：已修复代理和并发；「装完找不到」只改成能看到原因，根因待用户下次安装的输出确认
- 症状：设置 · Agent 安装 Claude Code，npm 每个元数据请求 1.7–2.4 秒，最后 `changed 2 packages in 5m`；装完检测报 `This version of C:\Users\...\npm\node_modules...`，面板判「找不到 claude」；另一个 Agent 在装时点安装被拒
- 入口：`server/install.ts` 的 `plan` / `run` / `POST /:id/:action`；`server/npm-env.ts`
- 根因类型：npm 子进程没拿到面板的代理；npm 默认藏起包的安装脚本输出；全局只许一个安装任务
- 模块：`server`
- 关键词：npm 安装慢、代理、HTTPS_PROXY、系统代理、postinstall、foreground-scripts、claude.exe 占位、并发安装

## 现象

用户报：「首先为啥安装这么慢，然后每个 Agent 同时只能有一个在更新安装」。日志里 `registry.npmjs.org` 的请求都是 `cache revalidated`、每个约 2 秒；tgz 都是 cache hit，却用了 5 分钟；装完检测报 Windows 的「This version of … is not compatible」。

## 根因

1. 代理：面板自己访问外网走 `netFetch`（设置 → 环境变量 → 系统代理 → 直连），npm 是子进程，`childEnv` 只给它 `process.env`。npm 不读系统代理，也不知道面板设置里的代理，于是一直直连 npmjs。Claude Code 带 8 个平台包，每个都要重新验证元数据。
2. 5 分钟和找不到命令（推断，未在用户机器上复现）：`@anthropic-ai/claude-code` 的 `bin/claude.exe` 是 500 字节的 shell 占位文件，靠 postinstall（`install.cjs`）把平台包 `claude-code-win32-x64`（解压后约 340 MB）里的真二进制链接 / 复制过来。检测报的 Windows 错误正是运行这个占位文件的表现，说明 postinstall 没放好二进制。`install.cjs` 在找不到平台包时只打印、退出码 0，而 npm 默认隐藏安装脚本输出，所以页面上没有线索。最可能的情况是 claude.exe 正在被运行中的 Claude Code 占用，Windows 上替换失败，npm 把可选依赖的失败当成可忽略并反复重试（耗时）。
3. 并发：`POST /cli-install/:id/install` 只要有任何一个任务在跑就返回 409。

## 修复

- `server/npm-env.ts`：按面板同一套顺序算出 npm 仓库要用的代理，设置里的或系统代理先握手确认活着，再写进 `HTTPS_PROXY` / `HTTP_PROXY` 交给 npm（`.npmrc` 自己配的仍然优先）；输出第一行说明走了哪个代理。查最新版本的 `npm view` 也用它。
- npm 安装加 `--foreground-scripts`，安装脚本的报错进输出。
- 命令找得到、一运行就报错时，失败文案带上实际报错，并提示先关掉还在运行的这个 Agent。
- 只拦同一个 Agent 的重复安装（返回正在进行的那次），不同 Agent 可以同时装 / 更新 / 卸载。

## 防线

- `server/npm-env.test.ts`：系统代理和设置里的代理写进环境变量、连不上时不写并说明、来自环境变量时不改。
