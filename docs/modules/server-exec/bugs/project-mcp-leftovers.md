# 项目 .mcp.json 里的面板 MCP 越积越多

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run test:e2e` 通过）
- 模块：`server-exec`（`server/exec/invoke.ts`），配套 `server/ask-mcp.ts`、`server/panel-mcp-files.ts`、`server/project-mcp.ts`、`server/index.ts`
- 关键词：.mcp.json、panel-xxxxxx、orch、127.0.0.1:8787/api/mcp/ask、项目里识别到的配置、只在项目里

## 现象

用户没加过任何 MCP，项目设置「MCP」里「项目里识别到的配置」却列出 27 条 `panel`、`orch`、`panel-19f169` 之类，
地址都是 `http://127.0.0.1:8787/api/mcp/ask/<uuid>`（老的还有 `/api/mcp/orch/<uuid>`），来源 `.mcp.json · Claude Code 项目配置`，还能点「导入」。

## 根因

- 写配置文件接面板 MCP 的 CLI（Command Code 写项目根 `.mcp.json` 和 `.commandcode/settings.json` 的权限放行，Gemini CLI 写 `.gemini/settings.json`）每一轮用一个新名字 `panel-<令牌后 6 位>`，一轮结束才还原。
- 还原发生在 `invokeCli` 的 `finally`：面板被关掉、崩溃、被强制结束、更新重启时正在跑（或保活等下一句）的对话来不及还原，那一项就永远留在项目里。保活的对话进程会一直挂着，所以几乎每次关面板都会留下几条。
- 还原是「把整个文件写回第一轮开始前的快照」：快照里已经有上次留下的残留，残留就跟着一直被写回去；执行期间用户改的内容反而会被冲掉。
- 老版本用过固定名字 `panel` 和单独的编排服务 `orch`，也都留在了用户项目里。
- 项目设置的扫描不认面板自己的地址，把这些残留当成用户的工具列出来，还允许导入。

## 修复

- 名字统一：写配置文件的 CLI 在同一个目录里第一轮固定叫 `agent-panel`，只有同时在跑的另几轮才带后缀（`claimPanelName`），平时项目里最多一项。
- 还原只撤掉这一轮自己加的键和数组项（`unmerge`），同时在跑的另几轮、执行期间用户加的内容都留着；撤完和执行前一样时写回原文，格式不变；这一轮新建的文件撤完只剩空壳就删掉。
- 清理：每轮写配置前清一次这个目录（`sweepPanelMcp`），面板启动时清一遍所有项目目录：地址指向本面板端口、令牌已不在的条目，连同 `mcp__<名字>__*` 权限放行一起删掉；文件因此变空就删掉。别的端口上的条目不动（可能是另一个正在跑的面板）。
- 项目设置的扫描跳过面板自己的地址（`isPanelMcpUrl`），不再列成可导入项。

## 防线

`server/panel-mcp-files.test.ts`（名字、清理、撤回不冲掉别的条目）、`server/project-mcp.test.ts`（扫描不列面板自己的）、`scripts/e2e/07-local.mjs`（原有配置原样还原）。
