# Pi 桥接扩展列工具超时，整轮丢掉全部面板工具

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit` 通过）
- 症状：Agent 节点里写着「面板工具（set_plan、run_background、submit_merge）现在不可见，改用普通命令跑验证」，只能自己用普通命令跑测试
- 入口：`server/exec/invoke.ts` 的 `invokeCli`，桥接扩展脚本在 `shared/clis/pi.json` 的 `mcp.files`
- 根因类型：超时太短且不重试，失败后放弃注册全部工具
- 模块：`server-exec`（`server/exec/invoke.ts`、`server/exec/runner.ts`、`server/exec/parsers.ts`），配套 `shared/clis/pi.json`、`server/panel-mcp-files.ts`
- 关键词：面板工具、set_plan、run_background、submit_merge、Tool set_plan not found、tools/list、握手超时、agent-panel-tools、tools_failed、桥接扩展

## 现象

执行角色（Pi）的 Agent 节点，回复正文里直接写着面板工具不可见，后面的验证改成自己敲普通命令跑。
模型侧的表现是调用面板工具时报 `Tool set_plan not found`：工具本来该由这一轮写进面板临时目录的桥接扩展注册给 Pi，
模型看得见的工具清单里没有它们，只能退化成「用普通命令跑」。第一条证据里点名的是 `set_plan`、`run_background`、`submit_merge`。

用户随后又给了第二条证据（另一个 Agent 的输出）：「本次「评审」复看未能派第二轮：`spawn_agents` 等面板工具在整改期间不可见，
改用「每条 fix 都有能拦住它的断言 + 亲手确认改前失败改后通过」作为替代证据。」`spawn_agents` 也不可见，说明丢的不是某一个工具，
而是**整批**面板工具；「在整改期间不可见」还说明它是**中途消失**的——一开始有，某一轮之后没了。

## 根因

注入本身是成功的：`invokeCli` 每一轮把桥接扩展写到 `{dir}/agent-panel-{name}.ts`，启动参数按绝对路径用 `-e` 加载它。
丢掉工具发生在扩展内部：

- Pi 的桥接扩展与面板 MCP 端点之间要发两次请求——握手 `initialize` 和列工具 `tools/list`，原来两处套用同一个 3 秒超时。
- 面板正忙（压缩上下文、写大对话）时 `tools/list` 会晚几秒才回，3 秒没等到就抛错。
- 抛错落进同一个 `catch`：整段注册流程结束，`pi.registerTool` 一次都不调用，这一轮的面板工具全部消失；只有 `console.error` 和一个状态键记下原因。
- 3 秒这个值又不能整体调大：Pi 启动时会等扩展加载完才读 stdin，握手拖长会让 Pi 迟迟不读输入，面板侧看到的是「get_state 没有响应」。

「中途消失」只有一种形态：

- 面板工具在 Pi 进程启动时由 `-e` 加载的桥接扩展一次注册完（`tools/list` 拉整批，`pi.registerTool` 逐个注册）；
  同一进程的保活续轮只发 `prompt`，不会再注册、也没有注销工具的动作——进程活着，工具不会自己少掉。
- 所以「一开始有、跑着跑着没了」一定是那一轮重新拉起了进程（保活回收后冷启动、`resume`、失败重试），
  新进程的扩展又没加载成功：握手 `initialize` 超时，或者 `tools/list` 两次都没回来（见上面那条）。
- 跟并发数本身无关：每一轮用 `scratchDir()` 开一个自己的临时目录（`server/exec/invoke.ts` 的 `CACHE_DIR/cli-run/<randomUUID 前 12 位>`）
  写扩展，`finally` 只删自己的；`sweepPanelMcp`（`server/panel-mcp-files.ts`）清的是 `panelConfigFiles()` 里那些
  写进项目目录的配置条目（Command Code 的 `.mcp.json`、Gemini CLI 的 `.gemini/settings.json`），不碰 `{dir}` 下的扩展。
  10 条以上并发时丢工具的真实原因是面板 MCP 端点变忙、`tools/list` 晚回，落到同一条超时路径。

## 修复

- `shared/clis/pi.json` 的桥接扩展改成一份总预算加单步超时：`LOAD_BUDGET_MS = 10000` 是扩展加载的总预算，握手 `initialize` 和
  列工具 `tools/list` 共用（`call()` 每一步按 `STEP_TIMEOUT_MS = 4000` 截断、`STEP_ATTEMPTS = 2` 次，超时再试一次，但总耗时不超预算）；
  `rpc()` 多一个 `what` 参数，超时错误里写清是「握手」还是「列工具」。
- 注册前核对核心工具：`CORE_TOOLS = ['get_status', 'send_message', 'read_messages']` 是各身份（主对话、子对话、子任务、工作流节点）都有的三个，
  缺任何一个就走 `fail('面板的工具清单不完整，缺 …')`，不是只挡住空清单。只对服务名是 `panel` 或以 `agent-panel` 开头的扩展核对
  （扩展里 `const service = '{name}'`）；UI 设计的服务是 `design`，工具本来就不含这三个，不能对它也报错。
- `server/exec/parsers.ts` 的 `tools_failed` 提示改成说清后果：「这一轮所有面板工具都不可用（执行计划、后台命令、传话、收尾合并、向你提问），
  只能直接改文件、用普通命令跑；要这些工具就重开一轮」，英文 `shared/locales/en/server.ts` 同步。
- `server/exec/runner.ts` 收到 `failed` 的 `notice` 时写一条 `log.warn('agent', ev.text, { task, step, cli })`：事后能从日志查到是哪一轮、哪个 CLI 没挂上工具。
- `get_state` 不写死超时，走 `server/exec/rpc/session.ts` 的默认 `REQUEST_TIMEOUT_MS = 15000`（本次只把这个常量导出了，供测试引用）：
  改的是压小扩展自己的预算，不是加长面板的超时。`session.ts` 的优先级是「请求级 `action.timeoutMs` > 会话级 `requestTimeoutMs` > 默认 15 秒」，
  给 `get_state` 写死 30 秒会盖掉调用方显式传的 `requestTimeoutMs`，`server/exec/pi-rpc.test.ts` 里两条用 `requestTimeoutMs: 1000`
  验证超时诊断文案的用例（「请求超时时，错误里带等待秒数、进程状态和 stderr」「进程已经退出时，错误里带上 stderr 最后几行」）先失败。
- 最坏加载压到 10 秒后，离默认 15 秒还剩 5 秒给 Pi 冷启动、读 stdin 和回包，面板端点慢一点也不会把「工具没挂上」误判成「Pi 没有响应」；
  扩展脚本里那段注释也写上了这个关系（总预算、单步、两步共用）。
- 扩展里抽出 `fail(error)`：握手失败、列工具失败，以及**列到了但清单不完整**（`tools` 是空数组，或面板服务缺身份无关的核心工具）都走同一条上报通道
  （`ctx.ui.setStatus('agent-panel-tools', error)` + `console.error`），不再静默注册 0 个工具——
  工具全丢时模型至少能拿到一句「面板没有返回任何面板工具」，面板也能把它显示成失败提示，而不是让 Agent 自己写一句「工具不可见」。
- 新增三条回归用例（`server/exec/pi-rpc.test.ts`）：「Pi 桥接扩展：两轮并发启动都拿到整批面板工具，不是一个两个」
  （同一工作区两轮并发各自加载扩展，断言两边的工具清单都是 `server/orch-mcp.ts` 按子对话身份裁出的整批，不是一个两个）、
  「扩展文件被清掉后，下一轮启动会重新写回」（`applyConfigFiles` 写进临时目录 → 删掉扩展文件 → 下一轮重新写回）、
  「Pi 桥接扩展：面板一个工具都不给时要报给面板，不能静默注册 0 个」。
- 另加一条「Pi 桥接扩展：清单只给了一部分工具时也要报出来，不能只挡住空清单」：只返回 `get_status` 时也要上报缺了 `send_message`、`read_messages`。

## 防线

- `server/exec/pi-rpc.test.ts`：「Pi 桥接扩展：列工具晚回一次会重试，面板工具照样挂上」（第一次 `tools/list` 不回，重试后照常注册）、
  「Pi 桥接扩展：面板 MCP 端点不回时，初始化超时后照常加载，不再把 Pi 卡在启动阶段」（握手超时要放行，并把原因报给面板）。
- `server/exec/pi-rpc.test.ts`：「Pi 扩展最坏的加载时长要留在 get_state 默认超时之内：面板端点慢时不能判成「Pi 没有响应」」（从定义里读 `LOAD_BUDGET_MS`，`STEP_TIMEOUT_MS` / `STEP_ATTEMPTS` 读 `mcp.vars`，断言 `STEP_TIMEOUT_MS × STEP_ATTEMPTS <= LOAD_BUDGET_MS`，且最坏时长小于 `REQUEST_TIMEOUT_MS`——这个常量从 `server/exec/rpc/session.ts` 导入，并断言至少留 3000ms 余量给 Pi 冷启动、读 stdin 和回包（实际总预算 10 秒、默认 15 秒，余量 5000ms）；调大这几个常量会吃掉余量，超过阈值用例就失败）。
- `server/exec/pi-rpc.test.ts`：「Pi 桥接扩展：清单只给了一部分工具时也要报出来，不能只挡住空清单」（核心工具缺任何一个都上报，不是只挡空清单）。
- `server/orch-mcp.test.ts`：「子对话的工具清单：计划、后台命令、收尾合并都在；子任务只有查状态、后台命令和传话」（按身份裁剪工具清单是设计行为，改这里会立刻暴露）。
- 新增文案改的是提示原文，`npm run typecheck` 的漏翻检查会拦住只改中文不改英文的情况。

## 降级会带来什么风险

拿不到面板工具的 Agent 只能直接改文件、用普通命令跑，协作链路是断的：

- 派不了子任务（`spawn_agents`）、取不到其他节点状态（`get_status`）：评审没法派第二轮复看，只能自己在同一轮里看一遍。
- `submit_merge` 不可用：独立分支里的子对话做完了也交不回来，会卡在收尾，而面板不知道它已经做完。
- `set_plan` / `finish_plan` 不可用：进度不更新，父对话的计划面板一直停在旧状态。
- `run_background` / `request_build` 不可用：长测试、UE 编译只能塞在前台跑，超时或被打断就白跑。

实际后果是评审和验收降级成「亲手确认改前失败改后通过」这类替代证据（用户第二条证据里的评审就是这么做的）：
少一层独立复看，凡是「改对了但断言写偏」「只覆盖了正常分支」的问题都可能漏过去。
而 Agent 自己写一句「工具不可见」不等于面板报错，用户很容易把它当成普通说明滑过去，把只跑了替代证据的轮次当成已完成。

## 修好之前怎么判断验证可信度

- 先看那一轮回复里的失败提示：工具没挂上时扩展会上报，界面是一行失败提示（内部的 kind 是 `tools_failed`）：「面板的工具没接上（…）：这一轮所有面板工具都不可用（执行计划、后台命令、传话、收尾合并、向你提问）…」。
- 再去 `logs/` 搜同一句：`server/exec/runner.ts` 对 `failed` 的 `notice` 写 `log.warn('agent', …)`，带 `task`、`step`、`cli` 三个字段，能确认是哪一轮、哪个 CLI。
- 只有替代证据（Agent 自己用普通命令跑出可复现的红→绿）的轮次不能算「已完成」：验收点名要面板工具做的（派评审复看、`submit_merge` 收尾、更新计划步骤）要么重开一轮补上，要么由父对话自己核实，不能默认它做过。
- 拿到工具的正常轮次是整批：`tools/list` 一次给全，不会只少一个两个。只少某个工具时先查身份裁剪（见 `../README.md` 的整批清单），不是扩展加载的问题。
