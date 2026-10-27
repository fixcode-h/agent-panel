# server-exec：真实调用本机 CLI

- status: inferred
- source_paths: `server/exec/`
- entry: `server/exec/runner.ts`
- analyzed_at: 2026-10-24

## 职责

- 调用 CLI：按 `shared/clis` 里的定义拼参数、传任务、续接会话、选模型和思考强度（`server/exec/invoke.ts`、`server/exec/runner.ts`）。Agent 的回复语言规则也在这里交给 CLI：有系统提示词参数的（Claude Code、Codex、Pi）跟角色说明一起放进系统提示词，Command Code 用 `server/exec/prompt-lang-mod.ts` 生成的 `--mod` 追加，其余写在任务描述里并在末尾再提醒一次；细节见 [cli-config.md](../../cli-config.md) 的「回复语言」。
- 进程管理：启动、结束整个进程树（Windows 用 `taskkill /T /F`）、超时和孤儿进程回收、进程占用统计（`server/exec/process.ts`、`server/exec/orphans.ts`、`server/exec/proc-stats.ts`）。
- 进程登记按面板实例分账：每个实例一份 `cli-pids/<面板 pid>.json`，实例退出（`killAllProcesses` → `clearTrackedClis`）只删自己那份，启动清理（`cleanStaleCliProcesses`）只收「那份文件的面板 pid 已经不在了」的登记，不碰另一个还活着的实例正在用的 CLI。以前所有实例共用一份 `cli-pids.json`、退出时清空整份，一个测试面板退出就把正常在用的面板的登记全清了；那份文件又是读-改-写，两个实例同时登记会互相覆盖，丢掉的条目在面板被强杀后再也没有线索回收。判断「那个面板还活着」除了 pid 在，还要求命令行像面板服务（`looksLikePanelServer`）：pid 被无关进程复用时按遗留清理，不会永久跳过。
- 终态任务不留进程：子对话收尾落 `resolved` 后按 `owner` 再核对一次（`killTaskClis`）；另有兜底 `reapSettledTaskClis`（「算不算收口」只用 `shared/task.ts` 的 `taskSettled`，等下一句、计划没做完、父对话测试没过退回修复的都不算；别的活着的面板实例那份不碰，它内存里的状态比盘上新），启动后和每小时由 `server/index.ts` 的 `runCleanup` 跑，回收「任务已收口、登记的 CLI 还活着」的进程并写日志（任务 id、标题、存活分钟）。重启恢复名单 `restartUnfinished` 排除 `resolved` 和只是停在等下一句（`awaitingUser` 且计划已做完）的任务。
- 进程与内存按对话子树归属：每个登记的 CLI 进程带 `owner`（`taskId` / `rootTaskId` / `title`）。进程列表、关闭、清理、AI 清理建议和内存曲线都只认 `owner.taskId` 落在「当前任务 + 它的全部后代」里的登记（子树由 `shared/run-usage.ts` 的 `subtreeTaskIds` 算；`cleanableClis` 的 `taskIds`、`summarize` 的任务 id 集合都是这个口径）。所以打开子对话只看自己这一支，看不到父对话和兄弟。面板 server 自身的 RSS 不属于任何对话，不计入对话合计。历史采样同时写 `roots`（旧的整树口径）和 `tasks`（`aggregateByTask` 按 `owner.taskId` 聚合）：新样本按 `tasks` 求和。只有 `roots` 的旧样本，用当前任务 id 集合去匹配 roots 的 `root` 键（`server/exec/proc-stats.ts` 的 `summarize` / `sampleRss`）：当前是根对话时能还原整棵树；子对话的 id 对不上 roots 键，返回 `null`（未知）而不是 0——否则该点会和升级后的点混成一条 0 起步的曲线，趋势被误判成持续上涨；旧样本 roots 为空（当时整台机器没有任何登记的进程）时才返回 0。
- API 并发上限：API 设置里的 `maxConcurrent`（0 不限制，默认 0）按 API 计同时在请求模型的 CLI 调用。所有调用都从 `runner.ts` 的 `gatedRunAgent` 进，先拿名额（`server/api-slots.ts`，满了先到先得排队，排队时对话 / 步骤上带 `apiWait`，对话仍算在运行、能停止），结束时还。停在等下一句（`waitNext`）、工具里等子任务或主 Agent（引擎的 `yieldSlot`）时让出名额，接着干之前再拿回；占着名额等子任务会和排队的子任务互相等死。预热不占名额，等到第一句再拿。账号登录的 CLI 不受限。
  - `apiWait` 带 `reason` 区分来源：`start` 是这一轮还没开始、真的在排队等名额；`yield` 是这一轮已经在跑（CLI 正在出 token）、让出后又拿回时排上的队。两者在界面上不能显示成同一句话，见 `docs/modules/web/README.md` 的运行状态一行（给 `shared/schema.ts` 的 `ApiWait` 加字段时的理由也写在那里）。读写这个标记的只有 `server/exec/api-wait.ts` 的 `markApiWait` / `clearApiWait`。
  - 标记必须「此刻真的在排队」才存在：`takeApiSlot` 用 `try/finally` 无条件清，不再看「这一次有没有排过队」的闭包变量——复用别处已经在排的队（`ApiSlot` 的 `pending`）时那次回调不会触发，标记就没人清，会跟着快照留到任务结束。
  - `ApiSlot.drop()` 在排队期间要能撤销排队（内部 `AbortController`），否则名额被放行给一个已经放弃的 slot、永远不还：`used` 永久偏高 → `free()` 长期为 false → 后续调用更频繁排队。给 `ApiSlot` 加排队撤销时要同时保证「放行的名额与持有者一一对应」。
  - 两代排队交错时必须靠代数（`gen`）保护：`drop()` 后马上重新排队，上一代 `acquire` 的 `finally` 跑得比新一代晚，无条件写回 `pending` / `waiting` 会清掉新一代的撤销句柄，之后的 `drop()` 就撤销不了排队——同一个泄漏换了个入口。两个字段都要比代数后才清理。
  - 拿回时是 `start` 还是 `yield` 看**让出前手里有没有名额**（`ApiSlot.holding`）：持有过 = 这一轮跑起来后临时让出（`yield`）；没持有过 = 预热（prewarm）对话等用户第一句，这一轮从没出过 token，此刻排队就是真的还没开始（`start`）。不能只看「是 `waitNext` 就写 `yield`」，否则预热首句的真排队会被静默吞成「思考中」。
  - 覆盖分工：端到端测的是「名额满了→第二个对话排队（`apiWait.reason` 为 `'start'`）→前面停了往前挪→排队时能停止」以及「对话让出名额给两个子任务、名额是 1 时子任务一个一个跑」（`scripts/e2e/07-local.mjs` 的并发上限一段）；「让出→拿回」期间两代排队交错、`drop()` 撤销排队不泄漏名额这些毫秒级时序由 `server/api-slots.test.ts` 的单测覆盖，端到端不赌这种时序。
  - 它只是内存里的临时状态：`server/task-store.ts` 的 `parseTask` 读快照时丢掉 `apiWait`（任务和步骤都丢），否则进程重启后会把一条陈旧标记显示成「在排队」。
- 输出解析：各 CLI 的结构化输出转成面板的流式事件（`server/exec/parsers.ts`）。Pi 的自动重试是三种事件：`retry`（带次数、原因，画成「正在重试」）、`retry_failed`（画成失败卡片）、`retry_ok`（`auto_retry_end success: true` 的独立事件，只把前面那张「正在重试」收成「已恢复」，不额外占一行提示）；每次重试都写 agent 日志（kind、attempt、maxAttempts、error），事后能统计「总是失败」是哪一类。上游网关把连接断开的错误（502/503/504、`Connection closed`、`Response payload is not completed`）单列 `gateway` 类，判定只有 `shared/alerts.ts` 的 `isGatewayError`，runner 的网络断流和自动续接判定共用它，不和用户自己的网络错误混在一起；「正在重试」的展开说明按原因细分（网关断连 / 限流 / 上下文接近上限）。
- 常驻双向协议：Claude Code、Codex 的专用适配器和统一的 RPC 会话引擎（`server/exec/rpc/`），插话、中断、结束判断都在这里。请求超时时只有这一层同时看得见进程状态和 stderr：进程还活着、stderr 一个字都没有、**并且这一轮还没有过任何响应**（收尾请求 `after` / `exit` 超时不算）的环境性超时（高负载时 Pi 冷启动 + 桥接扩展加载会顶到 15 秒）会在结果事件上带 `envStall`，runner 据此把请求超时放宽到 `REQUEST_TIMEOUT_MS + mcp.vars.loadBudget`（Pi 是 25 秒，没有加载预算的 CLI 不重试）自动重试一次，两次都没有响应才报失败，对话里留一条说明（重试成功收成普通提示）。所有递归重跑都要接着传 `envStalls` / `envStallNotes`，漏传由 `hints.test.ts` 的源码断言守着。见 `bugs/pi-rpc-env-stall-retry.md`。
- 改动统计：对比任务开始时的 `git diff --numstat` 快照算出改动文件（`server/exec/git.ts`）。
- 子对话隔离：`childIsolation = worktree` 时在独立 worktree 里执行并按 git merge 合回（`server/exec/worktree.ts`）；依赖只放一份在 `worktrees/<项目>-<哈希>/node_modules`，独立目录里不放 `node_modules`、靠 Node / npm 向上解析（`ensureSharedDeps`：lock 变了才重刷，清理时跳过这一份）；`claim` 模式的文件认领在 `server/claims.ts`。

## 入口

`server/exec/runner.ts`：由 `server/tasks.ts` 在节点执行时调用，宿主决定「怎么调用一个 Agent」，执行引擎本身在 `shared/engine.ts`。

## 依赖

`shared/clis.ts` 的 CLI 定义（**不按 CLI 名字写分支**，差异一律做成定义字段）、`cross-spawn`。
协议适配器的样本输出放在 `server/exec/fixtures/`，格式说明见该目录下的 README。

## 回归验证

- `npm run test:unit`（`server/exec/*.test.ts`：解析、进程、RPC、孤儿进程、worktree、停止等）
- 重试与失败汇报：`shared/alerts.test.ts` 的「上游网关断开单列一类：502、Connection closed、响应没传完」「重试提示按原因给出不同的下一步」「重试的原因看不出时给通用说明」；`server/exec/parsers.test.ts` 的「Pi 的重试事件：带上次数和原因，重试成功后算恢复而不是失败」；`server/exec/pi-rpc.test.ts` 的「Pi RPC：自动重试显示在回复里，不当成失败」（既有约定：重试成功不能再多一行提示，`retry_ok` 只用来收卡）；`shared/plan.test.ts` 的「子对话执行失败：上报带上这次失败的原因」（重试耗尽、面板工具没接上、进程被回收都要出现在汇报里，已恢复的不算）。见 `bugs/pi-retry-upstream-diagnosis.md`。
- 环境性失败重试：`server/exec/pi-rpc.test.ts` 的「进程活着但没有输出就超时，结果事件标成环境性卡住」「stderr 里已经有报错时，超时不算环境性卡住」「进程已经退出时，超时不算环境性卡住（重试也白搭）」「正常结束的一轮不带环境性标记」；`server/exec/hints.test.ts` 的「环境性失败（进程活着、没有任何输出的超时）自动重试一次」「只重试一次：重试也超时就不再重试，失败卡片写明已重试过」「内容性失败不重试」「重试轮的超时按扩展加载预算推导」「重试成功：那张『没有响应』的卡收成普通说明」。见 `bugs/pi-rpc-env-stall-retry.md`。
- 会话按目录存：`shared/task-session-dir.test.ts` 的「sameDir：Windows 路径的大小写、分隔符、末尾斜杠都不影响判定」「sessionMoved：会话在别的目录里就算搬过」「没记过目录的会话不判为搬过」「对话在没有新字段时退回共用的 sessionDir」「新字段按会话分别记，优先于对话共用的 sessionDir」。改会话续接时特别注意：`resume` 的目录判定必须对子任务也生效，不能写成 `chat &&` 短路（见 `bugs/sub-session-other-project.md`）。
- 进程与内存口径：`server/exec/proc-stats.test.ts` 的「按任务汇总」「进程归属：只取当前子树任务的登记，祖先、兄弟和无归属的面板动作都不算」「清理白名单：只看当前对话及附属的任务登记」「内存历史：新采样按任务分开记，子对话只加自己这一支」「内存历史：旧样本只有根任务聚合时，子对话是未知而不是 0（不制造 0 起步的假曲线）」「内存历史：合计只算这个对话的 CLI，面板 server 单独给出」；`server/task-memory.test.ts` 的「会话内存分析接口：子对话的采样只加自己这一支，不算父对话和兄弟」；任务树本身在 `shared/run-usage.test.ts`（父/子/孙、兄弟、无关任务、数据里成环）。
- 终态任务停进程：`server/exec/orphans.test.ts` 的「登记按面板实例分账：一个实例退出不清掉另一个的登记」「启动清理不碰另一个还活着的面板实例的 CLI」「兜底回收：任务已收口、CLI 还活着的收掉；还在等下一句的不碰」「收尾后按任务回收：只动这个任务名下的进程」；`server/task-restart.test.ts` 的「重启恢复名单：已收口的不再拉起，只在等下一句的不算被打断」「终态判定：已收口的任务名下不该再有 CLI 进程」。
- API 并发上限：`server/api-slots.test.ts`（排队顺序、停止离队、调大上限放行、让出拿回不多占、「排队中放弃要撤销排队，放行的名额不能丢在没人持有时」）；`server/exec/api-wait.test.ts`（标记记下就清干净、让出后拿回带 `yield` 且不改步骤状态、开跑前排队才改成排队中、拿到名额或被停止都清掉）；`scripts/e2e/14-accounts.mjs` 的账号和 API 一步里，名额是 1 时第二个对话排队、排队时停止不再启动、对话和它派的两个子任务同用一个 API 不会互相等死。
- 面板工具注入：`server/exec/pi-rpc.test.ts` 的「Pi 桥接扩展：列工具晚回一次会重试，面板工具照样挂上」——面板忙时 `tools/list` 会晚几秒才回，一次没等到就把这一轮的面板工具全丢掉，模型只能退化成用普通命令；同文件的「Pi 扩展最坏的加载时长要留在 get_state 默认超时之内：面板端点慢时不能判成「Pi 没有响应」」——扩展加载期间 Pi 不读 stdin，最坏加载时长（总预算 10 秒，单步 4 秒 × 2 次，握手和列工具共用；单步超时和次数是 `shared/clis/pi.json` 的 `mcp.vars`，模板里只有占位符，测试注入小值）必须留在 `get_state` 的默认超时（`server/exec/rpc/session.ts` 的 `REQUEST_TIMEOUT_MS = 15000`）之内，留 5 秒给 Pi 冷启动、读 stdin 和回包，否则面板端点慢一点就被判成 Pi 卡住，一样用不了面板工具；同文件的「Pi 桥接扩展：这一轮没有编排工具（压缩、原生审查轮）时不报『工具清单不完整』」——压缩轮、原生审查轮 runner 不给编排工具（`runner.ts` 的 `def.mcp && !op`），只挂 `ask_user`；扩展按握手的 `capabilities.experimental.orchestration` 决定要不要核对核心工具，按服务名猜会把这种正常情况报成故障（见 `bugs/pi-bridge-compact-tools-misfire.md`）；同文件的「Pi 桥接扩展：声明了这一轮有编排工具却只给一部分时要报出来」——声明了有编排工具、却缺身份无关的 `get_status`、`send_message`、`read_messages` 任何一个，仍要上报清单不完整；`server/orch-mcp.test.ts` 的「子对话的工具清单：计划、后台命令、收尾合并都在；子任务只有查状态、后台命令和传话」——子对话身份必须拿到 `set_plan`、`run_background`、`submit_merge`，子任务按设计没有计划和收尾合并。见 `bugs/pi-bridge-tools-timeout.md`。
- 面板工具按身份裁剪（整批清单）：一次调用拿到的是**一整批**面板工具，不是挑几个。`server/ask-mcp.ts` 的 `openAskBridge` 把同一个面板 MCP 服务上的工具拼在一起，`server/exec/invoke.ts` 的 `invokeCli` 面板只占一个 MCP 服务条目：`ask_user`（这一轮有提问通道、CLI 又没有原生提问时；Claude Code、Codex 有自己的提问协议，不走这里）、`read_user_notes` / `wait_user_message`（CLI 定义里有 `notes` 时，`wait_user_message` 还要求没有原生提问；目前只有 Command Code）、`app_actions` / `app_do`（有编排工具、调用者又不是子任务时，见 ADR 0011），再加 `server/orch-mcp.ts` 的 `orchTools(o)` 按身份裁出来的编排工具。名字总表 `shared/panel-tools.ts` 的 `PANEL_TOOL_NAMES`（39 个）只用来把各家报上来的写法（裸名字、`mcp__panel-xxxx__`、`panel_`）认回面板工具，不代表每个身份都注册；`submit_build` 是 `submit_merge` 的旧名字，只留在 `callOrchTool` 的兼容分支里（保活的旧进程还在用），`orchTools` 不再注册它。身份由 `shared/engine.ts` 的 `makeOrchestra` 赋给 `Orchestra` 的字段，裁剪在 `orchTools`：
  - 主对话（项目里的顶层对话，最多 22 个）：`get_status`、`begin_edit`（项目用 worktree、不是统筹角色、还没开独立分支时）、`run_background`、`check_background`、`stop_background`、`set_plan`、`finish_plan`、`start_plan`（Agent 开了「按工作流执行计划」）、`list_conversations`、`create_conversation`、`send_to_conversation`、`list_peers`、`message_peer`（这五个要统筹角色，即 Agent 开了「分派子对话」）、`finish_child`、`request_build`（UE 项目里的统筹角色）、`p4_split_changelists`（P4 项目）、`project_lessons`、`record_lesson`、`spawn_agents`、`stop_subtask`、`send_message`、`read_messages`。
  - 子对话（最多 17 个）：`get_status`、`run_background`、`check_background`、`stop_background`、`set_plan`、`finish_plan`、`message_parent`、`suggest_next_step`、`submit_merge`（独立分支；UE 子对话编译走它的 `build` 参数，没有独立分支时改给 `request_build`）、`claim_files` / `release_files`（和兄弟共用目录时）、`project_lessons`、`record_lesson`、`spawn_agents`、`stop_subtask`、`send_message`、`read_messages`。
  - 子任务（`helper`，6 个）：`get_status`、`run_background`、`check_background`、`stop_background`、`send_message`、`read_messages`。按设计不能再派子任务、不能开计划或独立分支、不能收尾合并，结果推回派它的对话。
  - 工作流节点（最多 11 个）：`get_status`、`project_lessons`、`record_lesson`、`read_state`、`write_state`、`spawn_agents`、`stop_subtask`、`wait_agents`、`ask_main`（这次运行有主 Agent 时）、`send_message`、`read_messages`。
  - 工作流主 Agent（`@main`，12 个）：`get_status`、`run_workflow`、`close_run`、`project_lessons`、`record_lesson`、`read_state`、`write_state`、`spawn_agents`、`stop_subtask`、`wait_agents`、`send_message`、`read_messages`。
  - 几组容易误解的：`set_plan` / `finish_plan` 只给对话（`plans` 是「项目里的对话且不是子任务」），工作流节点没有执行计划，进度由流程图和步骤管；`run_background` / `check_background` / `stop_background` 跟着 `host.runBackground` 走，它只在 `task.mode === 'chat'` 时提供（`server/tasks.ts`：「只给对话用：工作流节点一跑完就结束，结果没有地方推回」），所以工作流节点没有，子任务有；`submit_merge` 只给独立分支的子对话（`canSubmit` = 非子任务且 `host.submitMerge` 存在，而它只在 `parentTaskId && isolated` 时给），`begin_edit` 只给还没开分支的根对话；`spawn_agents` 除子任务外都有，`wait_agents` 反过来只给不会自动交回结果的（工作流节点、主 Agent）——对话里子任务结果会自动交回，注册等待工具只会引来轮询；`message_parent` / `suggest_next_step` 只给子对话，`send_message` / `read_messages` / `get_status` 每个身份都有。Pi 这类 CLI 的整批工具在进程启动时由桥接扩展一次注册，保活续轮只发 prompt、不重新注册也不注销，所以「一开始有、后来没了」一定是那一轮重新拉起了进程且扩展加载失败（见上面那条和 `bugs/pi-bridge-tools-timeout.md`），不是某个工具被裁掉；压缩轮、原生审查轮只有 `ask_user` 是设计如此，不是丢工具。
- 改了执行流程、停止、续跑或 worktree 合并后跑 `npm run test:e2e`（用 `scripts/fake-cli` 模拟各 CLI，Windows 上在 WSL 里）

## 待确认

- 新增一种 RPC 协议：能只写 `shared/clis/*.json` 的就不要加适配器；必须加时先看 `server/exec/rpc/spec.ts` 和 `docs/cli-config.md` 的接入检查清单（待确认）。
