# ADR 0001：让 AI 对话操作面板自身功能——走 MCP 工具，CLI 只做可选薄壳

- 状态：被 [0011](./0011-app-actions-for-agents.md) 替代（选 MCP 的结论保留；「一个操作一个 `panel_*` 工具」改成动作注册表 + 两个固定工具）
- 日期：2026-10-23
- 影响范围：新增 `panel-ops.ts`（本次提议要新建的文件，现在仓库里还没有）；改动 `server/ask-mcp.ts`（注册与派发）、`server/exec/invoke.ts`（把面板组传进 bridge）、`server/exec/runner.ts`（`RealContext` 加一个可选字段）、`server/tasks.ts`（组装数据并注入）；`server/orch-mcp.ts`、`server/design-mcp.ts` 只作参照，不改；不涉及 `web/` 的界面改动（确认弹窗复用现有审批组件）
- 相关文档：`docs/cli-config.md`（`mcp` 能力、面板工具的接入方式）、`AGENTS.md`（硬规则与安全边界）、`docs/lessons/server.md`

## 背景

面板现在是「人点界面 → 服务端调 CLI」。AI 对话能操作自己的运行（派子任务、分子对话、认领文件、写计划），但操作不了面板本身：
列一下别的对话在干什么、读某个子对话的计划和日志、看整个运行的 token、新建一个对话、把子对话标成「解决」、停下或者合并——
这些今天都要用户手点。

用户的要求是：「当前软件的必备操作做成 CLI 还是 MCP，让 AI 对话可以操作软件某些功能」。这份 ADR 决定做哪一种、做哪些、按什么权限做。

结论先写在这里：**实现面用 MCP（面板已有的进程内 MCP 服务，不新增路由），CLI 只作为后续可选的薄壳去调同一份操作定义。** 下面给出理由、操作清单、权限模型和分期。

## 事实核对（动笔前读过的代码）

| 位置                                                                                                            | 现状                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/index.ts`                                                                                               | `app.route('/mcp', designMcpApi())` + `app.route('/mcp', askMcpApi())`：两套进程内 MCP 挂在同一个前缀下，各用一个路由文件                                                                           |
| `server/ask-mcp.ts`                                                                                             | 一次 CLI 调用开一个只在那一轮有效的 MCP 服务（随机令牌），挂 `ask_user`、`read_user_notes`、`wait_user_message` 和 `orch-mcp.ts` 的编排工具；反问和长等待用 SSE + 20 秒心跳，避免客户端判空闲断开   |
| `server/ask-mcp.ts`（`openAskBridge`）                                                                          | 令牌即会话：`close()` 时这一轮的提问全部作废；地址是 `http://127.0.0.1:<PORT>/api/mcp/ask/<token>`                                                                                                  |
| `server/orch-mcp.ts`                                                                                            | `orchTools(o: Orchestra)` 生成工具定义、`callOrchTool` 执行、`orchHint` 写进提示词的一句话用法；工具是否出现由 `Orchestra` 的能力字段决定（`o.plans`、`o.canBackground`、`o.child`…）               |
| `shared/engine.ts:249`                                                                                          | `Orchestra` 接口：一次调用能做什么全看它，`makeOrchestra(host, ctx, self)` 按 `ctx` 的能力拼出这个对象                                                                                              |
| `server/exec/invoke.ts`                                                                                         | 只有 `def.mcp` 且 `own` 或 `o.orch` 为真时才开 bridge，`servers.unshift({ name: fileBased ? 'panel-<后6位>' : 'panel', url })`：**一次调用只挂一套面板 MCP**（`ask-mcp.ts` 文件头也写明了这条约定） |
| `server/auth.ts`（`tokenGuard`）                                                                                | `/api/mcp/ask/`、`/api/mcp/design/` 白名单放行（CLI 没有 Cookie），令牌不对由接口自己回 404                                                                                                         |
| `server/mcp-store.ts`（`mcpApi`）                                                                               | 用户自定义 MCP：写进各 CLI 自己的配置（`CliDefinition.mcpStore`），面板不另存                                                                                                                       |
| `server/ask-mcp.ts`（`applyConfigFiles`）                                                                       | 文件型配置（Command Code、Gemini CLI、Pi）在用户项目目录里读改写合并，用完还原                                                                                                                      |
| `server/tasks.ts` 返回对象                                                                                      | `tasksApi({...})` 同时返回 Hono `routes` 和内部函数（`list`、`get`、`running`、`stopAll`…），`runUsageApi({ tasks })` 就是这么注入的                                                                |
| `shared/run-usage.ts`、`server/run-usage.ts`（口径实现在 shared 的 `runUsage`，接口是 server 的 `runUsageApi`） | 整个运行的口径已经算好：`total` / `own` / `sub` / `tps` / `runTps` / `children` / `helpers`；接口在 `server/index.ts:669` 用 `runUsageApi({ tasks })` 挂上                                          |
| `server/asks.ts`                                                                                                | 审批和提问的挂起表：`askSession(scope)`、`answerAsk`、`wantsAnswers`；界面走 `/asks?scope=` 和 `/tasks/:id/requests/:rid`                                                                           |
| `server/log.ts`                                                                                                 | 日志写 `<程序目录>/logs/`（写不进去退到数据目录下），保留 30 个文件 / 100 MB，`token=…` 会打码                                                                                                      |
| `server/exec/runner.ts`（`noPushEnv`）                                                                          | 子对话的独立分支用 `pushInsteadOf` 拦住 `git push`；推送策略是 `policy.push`（`gitPolicy: ask/allow/deny`，`shared/schema.ts:741`）+ `task.remotePush`                                              |
| `web/src/lib/api.ts`                                                                                            | 上面这些内部能力都已经有对应的前端调用（`tasks`、`taskChildren`、`taskRunUsage`、`mergeWorktree`、`stopTask`、`answerRequest`、`saveSettings`…），操作清单基本是这些的一一映射                      |

`docs/` 下以前没有 `adr/` 目录，这份 ADR 是第一条，索引见 `docs/adr/README.md`。

## 决策

### 1. 选型：AI 对话 → MCP；人 / 脚本 / CI → 可选的薄 CLI

| 维度        | MCP（选定）                                                           | CLI                                                |
| ----------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| 挂载范围    | 一次 CLI 调用开一个只在那一轮有效的服务，按任务作用域授权             | 谁都能在任何终端跑，权限要另想办法收               |
| 参数与返回  | JSON Schema 校验 + 结构化返回，模型直接看懂                           | 要解析命令行参数和文本输出                         |
| 出错处理    | `isError` + 可读原因直接回给模型，模型能自己改参数重试                | 退出码 + stderr，模型常常误解                      |
| 跨 CLI 一致 | 已经接好四个 CLI（`def.mcp` 里命令行参数 / 配置文件 / Pi 扩展三条路） | 要依赖 shell、PATH、引号转义（Windows 上最容易错） |
| 审批        | 可以让工具调用先弹面板确认再执行                                      | 需要在终端里交互，面板管不到                       |
| 依赖        | 只要 CLI 能连 127.0.0.1                                               | 要有 Node / 脚本入口，还要处理用户环境             |

`server/design-mcp.ts` 的文件头已经为「为什么不用命令行」写过一次结论（Codex 沙箱默认不能联网、Windows 引号容易错、每条命令都可能要审批、MCP 四个 CLI 都能直接放行）。这次是同一个判断，理由一致，不再重复论证。

**CLI 仍然更合适的场景**（所以保留为可选的薄壳，而不是不做）：

- 人手动敲一条命令查状态、跑一次测试；
- 长驻/批处理：定时汇总用量、CI 里读一次运行结果；
- 和其它工具组合（`panel tasks --status failed | jq`、写进 shell 脚本）；
- 排障时不想开浏览器。

薄壳的硬约束：**只调与 MCP 同一份操作定义，不另写一套逻辑**。命令面按组收敛（`panel tasks`、`panel children`、`panel usage`…），实现上复用 HTTP API（`/api/*`，人跑的时候用访问令牌，见 `docs/cli-config.md` 里令牌那节），MCP 那侧复用内部函数，两者共用的只有 `panel-ops.ts`（本次提议新建）里那份定义表。

### 2. 挂在哪里：合并进现有 `/api/mcp/ask/<token>`，不新开路由

理由，按权重排：

1. **保持「一次调用一套 MCP」的现约定**。`ask-mcp.ts` 文件头和 `invoke.ts` 的写法都是为了少一个连接、少一项配置；新开一套路由等于每次调用挂两个面板 MCP，文件型配置还要多合并一项，Pi 的扩展要加载两次。
2. **权限天然按任务作用域**。令牌就是这一轮的会话，关掉即失效；不用再造一套认证。
3. **`tokenGuard` 已经放行这条路**，不用改安全白名单（改白名单是有风险的动作，能不做就不做）。

代价：`handle()` 的工具列表变成「提问 + 编排 + 面板操作」三组，返回给模型的工具数变多。控制办法是分组注册（见「运行时」）：`tools/list` 拼数组、`tools/call` 按组派发（现在编排组就是一行 `orch.some`，`server/ask-mcp.ts:189`），新增的面板组只加一个分支，**不逐个工具写 `if`**。

**命名**：新工具统一 `panel_` 前缀（`panel_list_tasks`、`panel_get_usage`…），既有工具**不改名**。原因有证据：`orch-mcp.ts` 里 `submit_merge` 还留着旧名 `submit_build` 的兼容分支，注释写着「保活的 CLI 进程拿的还是旧工具列表」——改已有工具名会让还活着的会话调到不存在的工具。

### 3. 作用域分界

- `ask_user`、`wait_user_message`、`read_user_notes`：提问与插话通道，与操作无关，不动。
- `orch-mcp.ts` 的工具：**这一次运行内部**的编排（本节点的子任务、本对话的子对话、计划、共享状态、文件认领）。
- 新的 `panel_*` 工具：**跨对话、跨项目的面板数据与生命周期**（别的对话的状态、用量、设置、合并、停止、删除）。

同一个能力两边都沾时，以「对象是不是本对话」划线：`create_conversation`（本对话的子对话）留在编排组，`panel_create_task`（项目里新建一个独立对话）进面板组，名字和描述都要写明区别，避免模型混用。

**设计 MCP 不合并**：`design-mcp.ts` 的对象是设计文档，一轮设计开一个会话（`/api/mcp/design/<token>`），跟任务运行无关；它的工具里有 `view_image`、`screenshot` 这类重活，合进任务那套会让每次任务调用都白带一屏用不上的工具，直接把上下文吃掉。保持各开各的。

## 与现有 MCP 的关系

面板进程里已经有两套进程内 MCP，加上用户自己配的第三方 MCP，关系定成这样：

| MCP                              | 地址                              | 生命周期                                      | 带什么工具                                                                   | 这份 ADR 怎么处理           |
| -------------------------------- | --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------- |
| 设计工具 `server/design-mcp.ts`  | `/api/mcp/design/<token>`         | 一轮设计对话                                  | 控件树、属性、截图、生图                                                     | 不动，也不合并              |
| 提问与编排 `server/ask-mcp.ts`   | `/api/mcp/ask/<token>`            | 一次 CLI 调用（`openAskBridge` 到 `close()`） | `ask_user`、`read_user_notes`、`wait_user_message`、`orch-mcp.ts` 的编排工具 | 加第三组 `panel_*`          |
| 用户自定义 `server/mcp-store.ts` | 面板不代理，写进各 CLI 自己的配置 | 由 CLI 自己管                                 | 用户自己配的工具                                                             | 不动；`panel_` 前缀避开重名 |

- **路由**：设计、提问两套都挂在 `/mcp` 前缀下（`server/index.ts` 里那两处 `app.route('/mcp', …)`），`tokenGuard` 已经放行 `/api/mcp/ask/` 和 `/api/mcp/design/`（在 `server/auth.ts` 里）。面板组复用现成通道，不加白名单、不新增路由。
- **文件型配置的 CLI**（Command Code、Gemini CLI、Pi）：由 `applyConfigFiles`（`server/ask-mcp.ts:296`）在项目目录里合并配置，项名是 `panel` 或 `panel-` 加 url 后 6 位（`server/exec/invoke.ts:185`，同一目录几轮同时跑时靠它区分）。新增工具组不改这一段，仍然只多一项配置。
- **不走 `mcpApi`**：那套是「把用户配的第三方 MCP 写进各 CLI 配置」，面板工具不落在用户配置里，也不该出现在设置页的 MCP 列表里。
- **不做「子命令先包一层、MCP 再转调」**：两份 schema、两套错误处理，改一次要同步两处，必然漂。
- **面板组的位置排在编排组后面**：模型先看到「我能怎么调度自己」，再看到「我能看什么、动什么」，误把 `panel_create_task` 当成 `create_conversation` 的概率低一些；工具描述里也各写一句区别（见「决策」第 3 条）。

## 操作清单

权限级别只有三个：**read**（不改任何状态）、**write**（可回滚或影响很小）、**confirm**（先在面板上弹确认，用户点了才执行）。
「面板确认」一列是要不要走 `server/asks.ts` 那套挂起表 + 现有的审批弹窗。

### 读（read，第一阶段全做）

| 工具名                | 参数要点                                                  | 返回要点                                                                                                                 | 权限 | 面板确认 |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---- | -------- |
| `panel_list_tasks`    | `projectId?`、`status?`、`archived?`、`limit?`（默认 30） | 数组：`id`、`title`、`projectId`、`status`、`working`、`lastMessageAt`、`children`（子对话数）、`resolved`               | read | 否       |
| `panel_get_task`      | `id`                                                      | 标题、状态、计划摘要、`usage`（`RunUsage`）、worktree 的 `branch/ahead/dirty/merged`、最近 5 条消息开头                  | read | 否       |
| `panel_get_plan`      | `id`                                                      | 计划标题、两层步骤、每步状态与 `step.note`（在等什么）、计划是否已 `finish_plan`                                         | read | 否       |
| `panel_list_children` | `id`                                                      | 对齐 `/tasks/:id/children`：`id`、`title`、`status`、`working`、`cliAlive`、`requests`、`branch`、`activity`、`resolved` | read | 否       |
| `panel_get_log`       | `id`、`limit?`（默认 40）、`after?`（消息 id）、`role?`   | 消息列表：`role`、`at`、`text`（单条截到 2000 字）、`tools`、失败标记；被截断时给「还有更多，用 after 取」               | read | 否       |
| `panel_get_changes`   | `id`、`path?`                                             | 改动文件与增删行数、`worktree` 状态；给了 `path` 时附 diff（截到 8000 字），非 git 仓库要明说                            | read | 否       |
| `panel_get_usage`     | `id`                                                      | `RunUsage` 原样：`total`、`own`、`sub`、`tps`、`runTps`、`children`、`helpers`                                           | read | 否       |
| `panel_get_settings`  | 无                                                        | 白名单字段（`backgroundLimit`、`gitPolicy`、`requireToken`、语言、上下文阈值…）；**绝不返回密钥、访问令牌、账号信息**         | read | 否       |
| `panel_list_projects` | `q?`                                                      | `id`、`name`、`path`、`branch`、worktree 数、`gitPolicy`、活动对话数                                                     | read | 否       |

### 低风险写（write，第一阶段只做前四个）

| 工具名                | 参数要点                                           | 返回要点                                                                                               | 权限  | 面板确认 |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----- | -------- |
| `panel_rename_task`   | `id`、`title`                                      | 改后的标题                                                                                             | write | 否       |
| `panel_set_goal`      | `id`、`goal?`、`rules?`                            | 改后的目标与全局规则（对齐 `updateConversation` 的 `goal` / `rules`）                                  | write | 否       |
| `panel_resolve_child` | `id`、`resolved`                                   | 只改「解决」标记，不停 CLI、不影响父对话                                                               | write | 否       |
| `panel_set_ask_user`  | `scope` 或 `id`、`askUser`                         | 当前开关状态                                                                                           | write | 否       |
| `panel_create_task`   | `projectId`、`title`、`message`、`agent?`、`tier?` | 新对话的 `id` 和状态；description 里必须写明「与编排组 `create_conversation`（本对话的子对话）的区别」 | write | 否       |
| `panel_send_message`  | `id`、`text`、`interrupt?`                         | 交给哪个对话、是排队还是插入；**不允许发给自己这一轮所在的对话**（会自激）                             | write | 否       |

### 需确认写（confirm，第二阶段）

面板确认复用现有审批：`server/asks.ts` 的 `askSession(scope)` / `answerAsk`，界面上是同一个弹窗，MCP 侧表现为这次工具调用先挂住，用户点了才继续。用户拒绝时返回 `isError` 并带上拒绝原因，模型照常往下走。

| 工具名                   | 参数要点                                       | 返回要点                                                                   | 权限    | 面板确认 |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- | ------- | -------- |
| `panel_answer_request`   | `id`、`rid`、`allow`、`answer?` / `answers?`   | 回答结果；**审批类（要执行命令的那类）必须用户自己点**，模型不能替用户批准 | confirm | 是       |
| `panel_stop_task`        | `id`、`force?`                                 | 停止后的状态；`force` 的确认文案要写清「等于强杀，这一轮输出会丢」         | confirm | 是       |
| `panel_merge_worktree`   | `id`                                           | 合回哪个分支、结果；冲突时把 `conflict` 原样交给模型                       | confirm | 是       |
| `panel_discard_worktree` | `id`                                           | 已删除；确认文案写明「连目录一起删，没合回的改动会丢」                     | confirm | 是       |
| `panel_delete_task`      | `id`                                           | 已删除                                                                     | confirm | 是       |
| `panel_save_settings`    | 白名单 patch（与 `panel_get_settings` 同一份） | 保存后的设置                                                               | confirm | 是       |
| `panel_checkout_branch`  | `projectId`、`branch`                          | 切换后的分支；有未提交改动挡住时把 git 的说明回给模型                      | confirm | 是       |

### 长任务（走队列，不阻塞工具调用）

Codex 默认 60 秒工具超时，编译、测试、打包都不能在工具里干等。这两项复用 `run_background` 已有的独占队列：马上返回 job id，跑完结果由面板推回这个对话。

| 工具名              | 参数要点                                            | 返回要点                                                               | 权限    | 面板确认 |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- | ------- | -------- |
| `panel_start_test`  | `id` 或 `projectId`、`kinds?`（项目设置的测试步骤） | job id + 「结果会推回来」；命令按项目 `testSteps` 生成，不由模型随便写 | write   | 否       |
| `panel_start_build` | `projectId`、`kind`（构建 / 出包）                  | job id；`exclusive: true`，按项目排队                                  | confirm | 是       |

任意命令仍然走既有的 `run_background`（已经在用），不新开「随便跑一条命令」的面板工具。

### 明确不提供的操作

`git push`、建 PR、发布、改远端、P4 submit、切换 client、同步整个工作区。
理由不是「麻烦」，而是会和现有安全边界打架：这几件事要求用户明确授权，今天的机制是「这次对话里用户点过，记进 `task.remotePush`」+"项目 `gitPolicy`"（`shared/schema.ts:741`、`server/exec/runner.ts` 里的 `taskPolicy`），子对话的独立分支还被 `noPushEnv` 的 `pushInsteadOf` 直接拦死。MCP 工具如果能自己推，等于给模型开了一条绕开这两层的路。这些操作继续由对话里的 CLI 在用户授权后用 `gh` / `git` 做。

## 运行时

### 定义表

新增的 `panel-ops.ts`（本次提议新建）导出 `panelOps(deps)`，返回一组 `PanelOp`：

```ts
type PanelOp = {
  name: string // panel_list_tasks
  title: string // 一句话，进提示词用
  description: string // 给模型看的完整说明，写清「什么时候用」和「和编排组的区别」
  inputSchema: Record<string, unknown> // 手写 JSON Schema，给模型看
  level: 'read' | 'write' | 'confirm'
  run: (a: unknown) => Promise<ToolResult> // 入口第一件事是 zod 校验参数
}
```

JSON Schema 手写，和 `orch-mcp.ts:68 orchTools` 一致（那边也是手写，没有从 zod 生成）；参数在 `run()` 里再用 zod 校验一遍。两份都要：一份给模型看、一份给代码用，只在 `run()` 里信 zod。

### 权限怎么落地

`level` 只决定「要不要先弹确认」，不决定「能不能做」：

- `read`：只调查询类函数，不写文件、不改任务。
- `write`：改的是可回滚的小字段（标题、目标、解决标记、提问开关）。
- `confirm`：先在 `server/asks.ts` 挂起（`askSession(scope)`），用户在现有弹窗里点了才执行；拒绝时返回 `isError` 并带原因。
- 涉及 git 的操作（合并、切分支）在 `level` 之后再按 `task.remotePush` 和项目 `gitPolicy` 判一次，口径和 `server/exec/runner.ts` 里的 `taskPolicy` 一致。两层都过才执行，任一层拦下就把理由原样回给模型。
- 审批类回答（`panel_answer_request`）没有「模型代点」这个选项：要执行命令的那类必须用户自己点，工具只负责把请求和上下文摆到用户面前。

### 注册与派发

1. `openAskBridge` 多收一个 `panel?: PanelOps`，`close()` 时和提问一起作废。
2. `handle()`（`server/ask-mcp.ts:169`）里 `tools/list` 把面板组拼进工具数组（现在是 `ask` / `notes` / `wait` / `orch` 四段，`server/ask-mcp.ts:173`）。
3. `tools/call` 加**一个**按组派发的分支：`if (s.panel?.has(name)) return reply(await s.panel.call(name, msg.params?.arguments))`。照编排组现在那行的写法（`server/ask-mcp.ts:189`），不逐个工具写 `if`。
4. `invoke.ts` 那侧：`def.mcp && (own || o.orch)` 已经成立时才开 bridge，面板组跟着 `o.orch` 走，不另加条件。

### 数据从哪来

面板工具要的数据（别的对话、整个运行的用量、设置、合并和停止）都在 `tasksApi` 手里，`RealContext`（`server/exec/runner.ts:72`）只有本轮的 `task`、`project`、`settings`。所以：

- `server/tasks.ts:2568` 那个返回对象（`routes` + `list`、`get`、`running`、`stopAll`…）再导出面板组要用的几个函数；
- deps 在 `server/tasks.ts:1149` 组装 `RealContext` 的地方注入，写法照 `server/index.ts` 里挂 `runUsageApi({ tasks })` 的那几行：`runUsageApi` 也是这么拿到任务存储的；
- `RealContext` 加一个可选字段（例如 `panel?: PanelOps`），`invoke.ts` 原样转给 `openAskBridge`。子对话这轮不需要面板组时不传，工具列表里就没有 `panel_*`。

### 提示词

照 `orch-mcp.ts:669 orchHint` 的写法加一个 `panelHint`：只用一行列出组名和「什么时候用」，详细的放在各工具的 `description` 里。`invoke.ts` 只在有 `o.orch` 时拼进输入，免得每个子对话都白带一屏用不上的说明。

### 日志

每个 `panel_*` 调用写一行 `log.info('panel', ...)`（`server/log.ts`，`token=` 已打码），带 `task`、工具名、参数摘要、耗时、结果（read 记返回条数，write 记改了哪个对话）。凭这一行排障，不靠重放对话。

## 分期

| 阶段 | 内容                                                                                                  | 出口条件                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 一   | 九个 `read` 工具 + `panel_rename_task`、`panel_set_goal`、`panel_resolve_child`、`panel_set_ask_user` | 一个对话能自己答「项目里有哪些对话、各自在等什么、这个对话花了多少 token」，不用人点界面 |
| 二   | `confirm` 类七个（审批、停止、合并、丢弃、删除、存设置、切分支）+ 两个长任务工具                      | 确认弹窗走的是现有 `asks.ts` 那套；长任务回来的是 job id，不是干等                       |
| 三   | 薄 CLI（`panel tasks`、`panel children`、`panel usage`…）                                             | 只有真出现「脚本里定时查用量」的需求才做；不出现就停在阶段二                             |

顺序的理由：`read` 不动状态，出错最多是信息不准；`write` 可以改回来；`confirm` 类会停掉 CLI、删目录、合分支，必须先把确认通道和权限两层校验收稳。阶段一不碰 `asks.ts`，可以独立上线。

每个阶段的验收证据（单测 + `scripts/fake-cli` 的端到端）在这一阶段做完时补进对应提交，不在这份 ADR 里预言。

## 风险与代价

| 风险                               | 会怎么出现                                                            | 对策                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 模型给自己派活形成回路             | 同一次调用里 `panel_create_task` + `panel_send_message` 自己喂自己    | `panel_send_message` 禁发本轮所在对话；两个新建工具的 `description` 都写明和 `create_conversation` 的区别                            |
| 工具太多吃掉上下文                 | 一次调用挂 20 多个工具，每个几百字说明                                | 面板组只按层级挂（read 组全挂，write 组只在父对话挂）；描述写短，能省的参数用 `?`                                                    |
| 误删、误合                         | `panel_discard_worktree`、`panel_delete_task`、`panel_merge_worktree` | `confirm` + 文案写清丢什么；删除前把分支名和未合并提交数一并显示                                                                     |
| 变成绕开推送授权的口子             | 面板组被当成「能推」的入口                                            | 不提供 push / PR / 发布；合并只合本地分支，走的还是 `mergeWorktree` 那条路                                                           |
| `tools/call` 派发退化成一长串 `if` | 每个工具一个分支，越长越容易漏                                        | 定义表里带 `run`，派发只按组查表；可以在 `scripts/rules-check.mjs`（现有规则检查）里加一条：`ask-mcp.ts` 里不出现 `name === 'panel_` |
| 没有编排能力的场景也挂面板组       | `invoke.ts` 的判断写错                                                | 单测断言：不给 `o.orch` 时 `tools/list` 里没有 `panel_*`                                                                             |
| 面板数据和界面显示不一致           | 工具读的是磁盘那份，界面显示的是内存里执行中的那份                    | 一律走 `tasks.get(id)`（`current(id)`，内存优先），和 `runUsageApi` 取数方式一致                                                     |

代价认下来的是：`ask-mcp.ts` 从「提问通道」变成「面板能力入口」，一个文件的职责变多。控制手段就是上面这条：工具定义全在 `panel-ops.ts`（本次提议新建），`ask-mcp.ts` 只负责拼数组和按组派发。

## 开放问题

1. **面板组要不要给子对话**？子对话用得上「看一眼别的对话在干什么」，但误操作面也跟着放大。倾向：`read` 组给所有层级，`write` 和 `confirm` 组只给父对话（`task.parentTaskId` 为空时）。定下来之前先按「只给父对话」实现，放开比收回容易。
2. **截断字数**：`panel_get_log` 单条 2000 字、`panel_get_changes` 的 diff 8000 字，这两个数字是估的，实施时按最长 CLI 的上下文反推，别照抄。
3. **`panel_save_settings` 的白名单字段**：至少要有 `backgroundLimit`、`gitPolicy`、`requireToken`（`shared/schema.ts` 里这三个都在设置里），漏一个就会出现「模型说改了、实际没改」。完整名单在实施时对着设置页逐项过一遍再定。
4. **返回里要不要带版本号**：带上 `updatedAt` / `rev`（`tasksApi` 里执行中每次变化加一）能让模型判断「我看到的是不是最新的」，但要配套刷新语义；不带就靠「拿不到就重查」。
5. **薄 CLI 的形态**：独立发布还是 `npx` 一次性入口，取决于阶段三是否真的启动。
