# Pi 压缩轮误报「面板工具清单不完整」，卡片写着所有面板工具都不可用

- 状态：已修复（`npm run typecheck`、`npm run lint` 通过；新增回归用例见「防线」）
- 症状：一个「统筹」角色（Pi CLI）执行到一半，整条 Agent 节点变成「Agent 执行失败」，红色卡片报「面板的工具没接上（面板的工具清单不完整，缺 get_status、send_message、read_messages）：这一轮所有面板工具都不可用（执行计划、后台命令、传话、收尾合并、向你提问）」
- 入口：`server/exec/runner.ts` 的 `runAgent`（压缩轮、原生审查轮不给编排工具）、`server/exec/invoke.ts` 的 `invokeCli`（没有编排工具时只挂提问工具）
- 根因类型：非编排轮只挂提问工具，桥接扩展仍按核心编写工具核对，把正常行为报成故障
- 模块：`server-exec`（`server/exec/runner.ts`、`server/exec/invoke.ts`、`server/exec/parsers.ts`），配套 `shared/clis/pi.json`、`server/ask-mcp.ts`
- 关键词：面板工具、工具清单不完整、get_status、send_message、read_messages、CORE_TOOLS、压缩、autoCompact、compact、op、agent-panel-tools、tools_failed、experimental.orchestration、ask_user

## 现象

用户给的截图：统筹角色（Pi，`tokenapi/deepseek/deepseek-v4-flash`）执行到一半，节点变成「Agent 执行失败」，报错原文就是上面那句。
用户的理解是「这一轮所有面板工具都失效，协作链整条断掉」——实际这一轮只挂了提问工具，编排工具本来就不该有。

## 根因

这条链每一步都在代码里：

1. `server/exec/runner.ts:1143`：`const orch = call.orch && def.mcp && !op ? call.orch : undefined`。
   Pi 的 `features.autoCompact: 'panel'` 在上下文占用到阈值时会自己发起压缩轮（`op.kind === 'compact'`），
   原生审查轮（`op.kind === 'review'`）同样带 `op`；这两类轮次故意不给编排工具（压缩、审查不该派子任务或改计划）。
   同文件的 `askUser: () => task.askUser` 没有这个条件，照旧传下去。
2. `server/exec/invoke.ts:188`：`const own = (askable || notes || wait) && !nativeAsk`。Pi 的 `askable` 恒为真，
   于是即使没有 `orch` 也会开桥接；`server/ask-mcp.ts` 的 `handle` 按会话里的字段拼清单，这一轮只有 `ask_user`。
3. `shared/clis/pi.json` 的桥接扩展：`tools.length` 非空，服务名是 `panel`，于是走 `CORE_TOOLS` 核对，
   缺 `get_status`、`send_message`、`read_messages` → `fail('面板的工具清单不完整，缺 …')`。
4. 上报走 `ctx.ui.setStatus('agent-panel-tools', error)`，`pi.json` 把它解析成 `notice(kind: tools_failed)`，
   `server/exec/parsers.ts` 再拼成失败提示。截图上那句就是这条文案。

对着父对话给的四个可疑方向逐一排除：

- 工具名形态：面板直接回 `orchTools` 的 `name`，没有 `mcp__panel__` 之类前缀。排除。
- 服务名判定：写成 `panel` / `agent-panel-xxxxxx` 两种都会命中核对，这一轮确实是 `panel`。不是误判的原因。
- 身份裁剪：`get_status` / `send_message` / `read_messages` 在 `server/orch-mcp.ts` 里是无条件项，任何身份都有。排除。
- Pi 的 MCP 懒加载：面板工具不走 Pi 自己的 MCP（`~/.pi/agent/mcp.json`），而是 `mcp.args` 里的 `-e` 扩展，
  扩展自己当客户端一次 `tools/list` 拉整批、逐个 `registerTool`，启动时一次注册完。排除。

「所有面板工具都不可用」这句也不对：扩展的 `fail()` 只做 `console.error` + `setStatus`，不阻断后面的注册循环，
这一轮拿到的 `ask_user` 照常注册了。截图里报的是「缺三个核心编排工具」而不是「面板没有返回任何面板工具」，
说明清单非空、注册了一部分。文案夸大了后果。

## 修复

- `server/ask-mcp.ts`：`initialize` 响应加 `capabilities.experimental.orchestration = !!s.orch`，
  由面板告诉扩展这一轮挂没挂编排工具。
- `shared/clis/pi.json` 的桥接扩展：读握手标志决定要不要核对 `CORE_TOOLS`，删掉按服务名猜的 `const service`。
  压缩轮、审查轮不再误报；身份真的被裁错（声明有编排工具却缺核心工具）时照旧上报。
- `server/exec/parsers.ts` 与 `shared/locales/en/server.ts`：`tools_failed` 文案改成「缺的那些这一轮用不了」，
  不再无条件断言「所有面板工具都不可用」。

## 防线

- `server/exec/pi-rpc.test.ts`「Pi 桥接扩展：这一轮没有编排工具（压缩、原生审查轮）时不报『工具清单不完整』」：
  用真实 `openAskBridge({ ask })` + `askMcpApi()` 起一个端点（`servePanelMcp`），加载生产路径生成（`mcpConfig`）的扩展，
  断言不报警告、没有 `console.error`、`ask_user` 照常注册。改前这条用例会报出截图里那句原文。
- `server/exec/pi-rpc.test.ts`「Pi 桥接扩展：声明了这一轮有编排工具却只给一部分时要报出来」：
  握手声明 `orchestration: true` 但清单缺核心工具时仍要上报，写明缺了哪个。
- `server/ask-mcp.test.ts`「握手告诉桥接扩展这一轮有没有编排工具」：有 / 没有编排工具两态的标志。
- `server/exec/parsers.test.ts`：`tools_failed` 的提示里不再出现「所有面板工具都不可用」。

## 和上一份的关系

`pi-bridge-tools-timeout.md` 是「列工具超时 → 整批丢工具」，报的是「面板没有返回任何面板工具」；
这次是「列到了、但这一轮本来就没有编排工具」。两者共用 `agent-panel-tools` 上报通道和 `CORE_TOOLS` 设计，根因不同。
上一份里「只对服务名是 `panel` / `agent-panel*` 的扩展核对」的做法这次被换成了按握手声明核对。
