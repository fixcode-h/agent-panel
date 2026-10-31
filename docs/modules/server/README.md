# server：本机 API、JSON 存储、项目和任务管理

- status: analyzed
- source_paths: `server/`
- entry: `server/index.ts`
- analyzed_at: 2026-10-27（本轮把「自动压缩上下文」的默认值从「按 Agent 自己的规则」（0）改成 70%，并给设置加了 `defaultsVersion` 迁移版本；同日新增「子对话把禁止子对话执行的角色转交父对话」一条，并合入同日「运行区展示正在跑的工作流」；测试步骤那条追加了「以项目当前设置为准」；同日第三轮把「打开一个对话页时服务端重复付的代价」里剩下的 P1 全部改成现在的行为，并补上 4200 条对话的实测与四个回归测试；同日补「版本更新」一节：GitHub 403 限流时回退缓存、ETag/304、冷却与 `GITHUB_TOKEN`）；2026-10-28 图片附件改为直接放对话目录根（不再有 attachments/ 子目录），git 的更改列表和评审差异按任务上记的 placedAttachments 排除面板图片

## 职责

- 本机 HTTP API：Hono + `@hono/node-server`，只监听 `127.0.0.1`（因为会启动本机 CLI、读写项目目录），同时提供前端静态文件（生产模式由 `server/static.ts` 托管构建产物：gzip + 缓存头 + ETag，见 [performance.md](performance.md)）。
- 数据存储：用户数据是数据目录（默认 `~/.agent-panel`）下的 JSON 文件，读写集中在 `server/store.ts`，任务单独存在 `server/task-store.ts`。
- 项目与任务：项目扫描和分类（配合 `shared/project-scan.ts`）、任务创建、排队、停止、续跑、任务快照（`server/tasks.ts`、`server/task-store.ts`）。
- CLI 相关：检测本机 CLI、读取模型列表、一键安装 / 更新 / 卸载（`server/detect.ts`、`server/models.ts`、`server/cli-packages.ts`、`server/install.ts`）。
- 面板能力给 Agent 用：进程内 MCP 工具，编排（`server/orch-mcp.ts`）、向用户提问（`server/ask-mcp.ts`）、UI 设计（`server/design-mcp.ts`）。`spawn_agents` 顶层的 `agent` / `tier` / `resume` 是整批默认值，顶层写错字段直接报错（以前只读 `tasks[i]`、顶层 `resume` 被静默丢掉，复看会退回默认「子任务」角色，见 [bugs/helper-resume-lost-role.md](bugs/helper-resume-lost-role.md)）；resume 命中时角色怎么定、`tier` 跟谁，规则在 [shared 模块 README 里「对话的执行计划」那一条](../shared/README.md)。
- 其他：附件和上传、文件系统接口、AI 创建 / 优化的提示词组装（`server/assist.ts`）、项目教训、导出、版本更新。
- Skills / 命令库（`server/library.ts`）：各 CLI 用户目录下的 Skill 和自定义命令的列表、读写、复制、删除；一个 Skill 目录里的多个文件（`SKILL.md` 以外的脚本、参考文档）走 `/library/entry` 的读 / 写 / 删 / 改名，见 [library.md](library.md)「技能库的多文件管理」。
- 出网请求（`server/net.ts`）：面板访问 GitHub 的统一入口 `netFetch`，按「设置里的代理 → 环境变量 → 直连」出网，直连或配置的代理失败后自动改用本机正在运行的代理重试；版本更新和安装包下载都用它，见 [network.md](network.md)「GitHub 出网与代理回退」。

这份 README 只放概览、`server/tasks.ts` 的拆分表和入口，各块的细节在同目录的子页面里（2026-10-31 从这份 README 原样拆出）：

| 子页面                                     | 内容                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [子对话、提问与计划推进](children.md)      | 子对话分派和完成流转、`/children` 摘要、删除独立分支、提问开关联动、合回后的父对话测试、计划推进、转交父对话 |
| [定时计划、设置与其他接口](features.md)    | 定时计划、设置的默认值迁移、后台命令和进程路由、回收站、对话搜索、工作总结、联网搜索代理、教训草稿、项目更新 |
| [打开对话页的服务端开销](performance.md)   | 打开一个对话页时服务端重复付的代价和两轮优化的实测                                                           |
| [数据落盘、对话日志与附件](storage.md)     | 原子写入与损坏恢复、对话专属日志、附件落盘                                                                   |
| [状态回收与强制更新后的恢复](lifecycle.md) | 面板重启和页面宽限到期后的状态回收、强制更新后的恢复名单                                                     |
| [技能库的多文件管理](library.md)           | `server/library.ts` 的多文件接口、路径安全、软链接、大小和树上限                                             |
| [出网、版本更新与账号登录](network.md)     | GitHub 出网与代理回退、版本更新、账号与登录                                                                  |
| [每轮改动卡片与撤销](turn-changes.md)      | 对话每轮的改动记录和撤销                                                                                     |
| [bugs.md](bugs.md)                         | 本模块用户报过的 Bug 索引（生成物，详情在 `bugs/`）                                                          |

## server/tasks.ts 拆分后的位置（ADR 0033）

文档、教训和 Bug 记录里写「`server/tasks.ts` 的 `xxx`」的，函数名没变，按下表找所在文件。`tasksApi` 本身只留共用状态、小工具、路由组装和对外接口；模块经 `TasksScope`（`server/tasks/scope.ts`）取闭包里的名字。

| 文件                                              | 内容                                                                                                                                                                                                                                                                | 主要函数                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `server/tasks.ts`                                 | 共用状态和小工具、路由组装、对外接口                                                                                                                                                                                                                                | `tasksApi`、`current`、`peerOf`、`placeInTask`、`autoArchive`                              |
| `server/tasks/run.ts`                             | 开始一轮、接着说、消息交付、卡住重开                                                                                                                                                                                                                                | `start`、`followUp`、`deliver`、`restartStalled`                                           |
| `server/tasks/children.ts`                        | 子对话生命周期：计数、彻底完成的推进、合回、上报、一轮结束推进计划、启动子对话                                                                                                                                                                                      | `advanceChildTo`、`reportChild`、`nudgePlan`、`closeChildren`、`startChild`、`ruleCommand` |
| `server/tasks/merge.ts`                           | 子对话收尾：`submit_merge`、编译请求、就地微改动、`finish_child`、父计划等待步                                                                                                                                                                                      | `submitMerge`、`finishChild`、`finishChildStep`、`syncParentPlan`                          |
| `server/tasks/child-messages.ts`                  | 父子之间的通知（ADR 0034：随父对话停下的中断、用户直接交代只改父计划不发信；同一子对话没读的汇报新的替换旧的；AI 的阶段汇报由 `reportChild` 并进一轮那一封）                                                                                                        | `noteParent`、`sendToChild`、`trackUserToChild`、`notePlanInput`                           |
| `server/tasks/peer.ts`                            | 子对话传话给父对话、转交子任务                                                                                                                                                                                                                                      | `messageParent`、`forwardSpawn`、`attachOrchestra`                                         |
| `server/tasks/asks.ts`                            | 提问和确认、叫醒对话                                                                                                                                                                                                                                                | `wakeConv`、`answerChildAsk`、`delegateAsk`、`settleAsks`                                  |
| `server/tasks/edit-worktree.ts`                   | 独立分支：合并排队、恢复和开出 worktree、`begin_edit`                                                                                                                                                                                                               | `mergeLock`、`ensureChildWorktree`、`beginEdit`                                            |
| `server/tasks/jobs.ts`                            | 后台命令的结果推回、列表、结束                                                                                                                                                                                                                                      | `background`、`endBackground`、`withJobs`                                                  |
| `server/tasks/test-runs.ts`                       | 父对话代跑测试、记录结果、重启后接着等                                                                                                                                                                                                                              | `startParentTests`、`recordSelfTestRun`、`recoverParentTests`                              |
| `server/tasks/idle-ask.ts`                        | 子对话没输出时自动询问                                                                                                                                                                                                                                              | `askIdleChildren`、`armIdleAsk`                                                            |
| `server/tasks/stuck-child.ts`                     | 子对话问过没回复：停掉接回原会话重启，重启没恢复记警告并新开子对话接手（ADR 0036）                                                                                                                                                                                  | `restartStuck`、`checkRestarted`、`replace`                                                |
| `server/tasks/budget.ts`                          | 父对话用量上限：每轮结束按整棵对话树核一次，80% 提醒、用满停下（StopReason `budget`），算法在 `shared/budget.ts`                                                                                                                                                    | `checkBudget`                                                                              |
| `server/tasks/keepalive.ts`                       | 停止、保活上限与回收、进程面板                                                                                                                                                                                                                                      | `stopTask`、`keepAliveBusy`、`enforceKeepAlive`、`processPanel`                            |
| `server/tasks/startup.ts`                         | 启动迁移、合并中退回                                                                                                                                                                                                                                                | `migrateOnStart`、`reopenMerge`                                                            |
| `server/tasks/state-sweep.ts`                     | 定时核对                                                                                                                                                                                                                                                            | `createStateSweep`                                                                         |
| `server/tasks/trash.ts`                           | 回收站                                                                                                                                                                                                                                                              | `enterTrash`、`purgeTasks`                                                                 |
| `server/tasks/*-routes.ts`                        | 接口：`list`（列表、搜索、回收站、保活）、`children`、`process`（子任务 / 后台命令 / 进程 / 内存）、`read`（SSE、整份对话、导出导入）、`conversation`（新建、发消息、预热、继续执行）、`worktree`、`files`、`actions`（改设置、倒回、分叉、压缩、评审、停止、回答） | `createTask`、`prewarmChat`、`resumeKids`、`taskDir`、`childUnmerged`                      |
| `server/tasks/helpers.ts`、`types.ts`、`scope.ts` | 不依赖闭包的常量和小工具、`Live` 等类型、`TasksScope` 和 `lazyScope`                                                                                                                                                                                                |                                                                                            |

新功能放进对应模块，别加回 `server/tasks.ts`：它在 `scripts/file-caps.json` 里有行数上限（规则检查第 15 条）。

## 入口

- `server/index.ts`：路由登记和启动；第一行先加载 `server/lang.ts` 定界面语言。
- `server/net.ts`：需要访问 GitHub 的请求的统一入口 `netFetch(url, init)`（`init` 是 `RequestInit` 加可选的 `timeoutMs` 和 `onAttempt`）；`timeoutMs` 只限制等到响应头的时间，之后读 body 不受影响，不传就一直等；`onAttempt` 在每次尝试（含回退到另一条路）前调用，供调用方重置自己的空闲计时。
- `server/exec/`：真实调用 CLI 的部分单独成模块，见 [server-exec](../server-exec/README.md)。

## 依赖

`shared/` 的数据结构和 CLI 定义、`hono`、`zod`、`cross-spawn`（Windows 上调用 npm 安装的 `.cmd`）、`undici`（`ProxyAgent` 和走代理的 `fetch`，只在 `server/net.ts` 用）。定时计划的规则全在 `shared/schedule.ts`：服务端只按它判断到没到点、执行后怎么往后推，不自己再算一套。

## 回归验证

- `npm run typecheck`
- `npm run test:unit`（`server/**/*.test.ts`，每个模块基本都有同名测试）
- 动了定时计划：`server/schedules.test.ts`（到点启动一次、单次执行后不再触发、错过不补跑、立即执行不改排期、启动失败只记原因不重试、删除后不再触发、启动期间用户改排期不会被写回覆盖、同一分钟改名字不重置状态，时钟由测试注入）
- `server/settings-migrate.test.ts`：旧默认值 16 迁移成 64 并写回、已删掉的 `childConcurrency` 被忽略；`server/settings-migrate-keep.test.ts`：显式设过的 32 和已经迁移过的设置里显式选的 `autoCompact: 0` 都保持不动、不写盘；`server/settings-defaults.test.ts`：新装/没存过这一项时自动压缩是 70%、旧默认值 0 迁成 70（50 保持）、迁移后选回 0 不再被改
- 动了存储和落盘：`server/store.test.ts`（`writeJsonAtomic` 写成功后 `readJson` 能读回、覆盖写读到新内容、tmp 不残留；`readJson` 对不存在的文件报 `missing`；坏 JSON 被留档且调用方拿到「存在但坏了」和原路径、字节数，旁边有 `.broken.json` 说明；全 0 的空洞文件判成损坏并记下真实字节数）、`server/task-store.test.ts`（只有 `.messages.json` 时重建任务、记录全 0 时空洞文件留档后重建、对话文件全 0 时不重建不伪造且第二次启动不重复归档、对话内容不是消息数组时不重建只留档、已有记录不被重建覆盖）、`server/store-concurrency.test.ts`（集合的「读快照 → 改 → 写盘」整体串行）
- 动了任务重启迁移：`server/task-restart.test.ts`（这一轮还在跑的任务落成已停止并标出被打断的节点；计划没做完、独立分支没合回的子对话重启后不再画成在跑；彻底做完的不动；待收尾的保留收尾请求）
- 动了页面宽限回收 / presence：`server/reclaim.test.ts`（进程已回收、状态还写着 `running` 的等下一句任务被收口成 `stopped` + `stopReason: 'presence'`，`childSpinning` 转假、图标 `idle`；`working` 的真在跑任务不碰；已停下的不覆盖 `stopReason: 'user'`）
- 动了任务执行、项目、设置等跨界面流程时跑 `npm run test:e2e`（Windows 上在 WSL 里）
- 动了账号与登录：`server/accounts.test.ts`（`loginOutcome` 的各种结局、`loginFailure` 的文案分支、Command Code 的 `loginAlreadyLoggedIn`）、`shared/ansi.test.ts`（SGR 颜色、加粗 / 暗色开关、8 位 CSI、普通方括号文本不被改），以及 `npm run test:e2e` 里「已登录再登录」和「退 0 但没凭据」两条用例（模拟 CLI 用 `scripts/fake-cli/fake-cli.mjs` 的 `FAKE_AUTH_ALREADY` / `FAKE_AUTH_NO_CREDENTIALS`）
- 动了出网 / 代理：`server/net.test.ts` 覆盖系统代理解析（Windows 注册表输出、macOS `scutil --proxy`）、候选列表与 `pickLocalProxies` 的挑选顺序（默认端口在尝试范围内、只开默认端口也能被选中）、`planFor` 的优先级 / 无协议补全 / `NO_PROXY`、缓存失效（`markProxyBad`）、本机地址识别、直连失败换代理、配置代理失败后回退、全部失败时的文案、本机地址不探测、用户取消或总预算用完时停止、超时后重试、代理握手探测（起真实只处理 CONNECT 的本地服务）。`netFetch` 的回退路径通过 `netFetchWith` 注入 `NetDeps`（`plan` / `direct` / `viaProxy` / `discover` / `proxyFailed`）来测，不用真的连代理。`server/download.test.ts` 通过 `DownloadOptions.fetch` 断言探测、单连接下载和每个分片都经过统一入口、都带 20 秒响应头超时，并带 `onAttempt` 供回退时重置空闲计时；`net.test.ts` 另有用例确认每次尝试前会调用它。

## 待确认

- `server/` 下文件较多（API 路由集中在 `server/index.ts`），新增接口前先确认应该加在路由里还是拆成独立模块（待确认）。
