# Agent 面板 · 优化与补充清单（2026-10-26）

这份清单汇总四路调研（模块结构、可共用代码、测试与工程效率、体验与功能缺口）的结论，按优先级排好，方便逐项认领。

- 处理完一项，把该条的 `- [ ]` 改成 `- [x]`，并在该条下面追加一行「（YYYY-MM-DD 已完成 · 提交 `abc1234`）」。
- 行号是写清单时（提交 `5488fd7d`）的代码位置，改动后会偏移，认领前先按代码核对。
- 已经在做的写在第五节，不要重复认领。

## 一、重构与模块整理

- [ ] **server/tasks.ts 一个闭包装下全部对话逻辑** — 5704 行、只导出 3 个顶层函数，其余 96 个内部函数全在 `tasksApi` 闭包里（执行位与 presence 回收、worktree、submitMerge、父子派发、后台命令、测试步骤、附件落盘、计划同步）— 证据：`server/tasks.ts:295`、`server/tasks.ts:5704`，如 `submitMerge:1358`、`startParentTests:1278`、`placeInTask:517` — 建议：拆成 `server/tasks/{live,children,merge,background,tests,uploads}.ts`，`tasksApi` 只做组装与路由 — P0
- [ ] **演示版在后端重复实现整套 API** — `demo-backend.ts` 4191 行重写 `server/index.ts` 的 54 条路由，加 11 个 `demo-*.ts` 共 7774 行；字段只能人工对齐（已发生过一次字段漂移事故）— 证据：`web/src/lib/demo-backend.ts`（全文）、`server/index.ts`（54 处路由）— 建议：把请求处理抽成 shared 里的纯函数（入参 = 存储 + 执行替身），demo 只提供存储/执行实现 — P0
- [ ] **单函数 1400 行：runAgent** — `server/exec/runner.ts:808` 到 `server/exec/runner.ts:2222` 一个函数里含 CLI 调用、重试/退避、RPC 保活、token 累加、工具块解析、交付与空回合判定、错误归类 — 证据：`server/exec/runner.ts:808`、`server/exec/runner.ts:2222` — 建议：拆成 `call` → `attempt`（含重试策略）→ `postprocess`（解析+统计+判定）三段，每段可单测 — P1
- [ ] **engine.ts 提示词拼装与流程执行混在一个 4224 行文件** — `shared/engine.ts:1007`–`shared/engine.ts:1326` 是约 20 个 `*Part()` 提示词片段，`shared/engine.ts:1418` 起才是节点与单元执行；`EngineHost` 接口 60 个成员全在 `shared/engine.ts:461`–`:722` — 证据：`shared/engine.ts:1007`、`shared/engine.ts:1418`、`shared/engine.ts:1817`、`shared/engine.ts:461` — 建议：拆出提示词目录（放 shared 下，纯字符串，可快照测）与执行核心；`EngineHost` 按能力拆成几个小接口 — P1
- [ ] **shared/task.ts 里同一份对话状态有七个判定入口** — `convState:529`、`stageOf:690`、`taskStage:978`、`childHolds:744`、`childFlowAt:887`、`childActivity:1128`、`childIcon:1376`；1988 行里混了构造、计时、状态、计划、子对话流程五件事 — 证据：`shared/task.ts`（上列行号）— 建议：拆出 `task-state.ts`，`childIcon` 定为唯一对外出口，其余降为内部或删除 — P1
- [ ] **TaskView 单组件 1840 行** — 一个 `TaskView` 组件里同时做消息分块与截断、双栏宽度拖拽与本地存储、RunChecklist、ChildrenBar、WorktreeBar、FlowBar、ChatTurn、RunPhase — 证据：`web/src/components/tasks/TaskView.tsx:374`、`web/src/components/tasks/TaskView.tsx:2214`（全文件 2878 行）— 建议：主组件只留布局与数据装配，宽度/分块/子对话条目到 `lib` 与独立组件 — P1
- [ ] **task-export.ts 六种职责挤在一个 1717 行文件** — 导出/导入、统计口径、报告生成、AI 演化解析与应用、diff、演示数据 — 证据：`shared/task-export.ts:699`、`shared/task-export.ts:786`、`shared/task-export.ts:427`、`shared/task-export.ts:941`、`shared/task-export.ts:1197`、`shared/task-export.ts:1287`、`shared/task-export.ts:1470` — 建议：拆 `task-export/{export,import,stats,report,evolution}.ts` — P1
- [ ] **22 对 shared/server 同名文件，边界只靠名字暗示** — `accounts assist data deploy docs fix lessons library memory` 等在 `shared/` 与 `server/` 各一份，看名字分不清哪层持状态、哪层是纯逻辑 — 证据：`ls shared/*.ts` 与 `ls server/*.ts` 取交集 22 个 — 建议：共享层改成 `<领域>/core.ts` 或按领域建子目录 — P2
- [ ] **三个目录平铺，测试与源码混放** — `server/` 顶层 185 个 ts 里 105 个是 `*.test.ts`；`shared/` 122 个；`web/src/lib` 128 个 — 证据：`ls server/*.test.ts` 计 105 个 — 建议：按领域建子目录，测试就近或集中到 `__tests__` — P2
- [ ] **schema.ts 把数据定义和历史迁移绑在一起** — 2378 行里还有 5 处数据迁移（`dropLegacyAgent:155`、`moveSessions:180`、`migrateWorkflow:377`、`migrateProject:738`、`migrateTask:1891`），全通过 `z.preprocess` 挂进 schema — 证据：`shared/schema.ts:155`、`shared/schema.ts:454`、`shared/schema.ts:1891` — 建议：迁移拆 `migrations/`（放 shared 下），schema 只留当前结构 — P2
- [ ] **ProjectSettingsDialog 2000 行装下所有设置页签** — 测试步骤、搜索排除、git 策略、角色/参数等页签实现全在一个文件 — 证据：`web/src/components/projects/ProjectSettingsDialog.tsx` — 建议：按页签拆到 `components/projects/settings/` — P2

## 二、可提取成共用

- [x] **统一文本截断 `clip`** — 同一个 `s.length > n ? s.slice(0,n)+'…' : s` 写了 8 份、约 72 个调用点 — 证据：`shared/engine.ts:718`、`shared/handoff.ts:30`、`shared/dispatch.ts:84`、`shared/design-analysis.ts:69`、`server/exec/runner.ts:473`、`web/src/lib/element-ref.ts:67`、`shared/summary.ts:164`、`shared/task-export.ts:903` — 建议：提取到 `text.ts`（放 shared）的 `clip(s, n, opts?)`，`clipDetail`/`clipTranscript`/`clipReport` 并进去 — P1
  （2026-10-27 已完成 · 提交 `99fb4a6d`；落地位置 `shared/text.ts`）
- [x] **统一剪贴板复制 `copyText`** — `navigator.clipboard` 共 23 处，其中 4 份独立函数、其余内联「writeText + toast」— 证据：`web/src/components/files/FileTree.tsx:88`（最完整，带 execCommand 兜底）、`web/src/components/tasks/Evolution.tsx:124`、`Worktrees.tsx:192`、`ToolDialog.tsx:25`，以及 12+ 处内联 — 建议：提取到 `copy-text.ts`（放 `web/src/lib/`，剪贴板 → textarea + execCommand 兜底 → 失败 toast）— P1
  （2026-10-27 已完成 · 提交 `99fb4a6d`）
- [x] **让服务端都走 `readJson`** — `store.ts` 已有带「损坏文件归档」的读法，但 20 处仍自己 `JSON.parse(await readFile(...))` — 证据：`server/store.ts:218`、`server/store.ts:242` 是已有实现；未复用的如 `server/models.ts:281`、`server/cli-config.ts:31`、`server/lang.ts:18`、`server/exec/orphans.ts:49`、`server/update.ts:42`、`server/accounts.ts:105` 等 — 建议：只把调用换成 `await readJson(file)`，让损坏文件也能归档到 `cache/broken` — P1
  （2026-10-27 已完成 · 提交 `99fb4a6d`）
- [x] **日期/时刻拼串 helper** — `padStart(2,'0')` 自定义 6 次，`YYYY-MM-DD` / `HH:mm` 手拼 8 处 — 证据：`shared/schedule.ts:159`、`shared/schedule.ts:219`、`shared/usage.ts:134`、`shared/task-export.ts:900`、`web/src/components/settings/UpdateSection.tsx:35`、`DataSection.tsx:123`、`CliLimits.tsx:84`、`web/src/components/design/Versions.tsx:17`、`fields.tsx:205`、`shared/memory.ts:25`、`shared/memory-analysis.ts:197` — 建议：提取到 `datetime.ts`（放 shared）的 `pad2` / `ymd` / `hhmm`，`shared/summary.ts:142` 的 `dayKey` 并入同一口径 — P2
  （2026-10-27 已完成 · 提交 `99fb4a6d`；落地位置 `shared/datetime.ts`）
- [x] **空态片区 `<EmptyPanel>`** — 同一串空态 class 出现在 11 处 — 证据：`web/src/components/library/BundledDetail.tsx:198`、`SkillFiles.tsx:298`、`web/src/components/projects/ProjectMcpSection.tsx:162`、`ProjectCategoryList.tsx:39`、`web/src/components/projects/Lessons.tsx:653` 等 — 建议：提取一个空态组件（内容 + 可选操作按钮）— P2
  （2026-10-27 已完成 · 提交 `99fb4a6d`；落地位置 `web/src/components/ui/empty-panel.tsx`）

## 三、测试与工程效率

- [x] **每个子对话整份复制 node_modules** — 已改：依赖只放一份在 `worktrees/<项目>-<哈希>/node_modules`，独立目录里不放、靠 Node / npm 向上解析；本机实测首次约 10s / 682MB、之后每个约 1s / 15MB（改动前 11–12s / 696MB） — 证据：`server/exec/worktree.ts` 的 `ensureSharedDeps`、`server/exec/worktree.test.ts` 的「依赖共用」用例 — P0
- [x] **UI 检查墙钟被 task 分片卡住** — 总 128.8s 里 task 独占 128.8s（121 步、3908 行），并行再多也压不下去 — 证据：`ui-timings.json`、`wc -l scripts/ui/02-task.mjs` 计 3908 行 — 建议：拆成 `02-task` / `02b-subagent` / `02c-element-pick`；`scripts/ui-check.mjs:27` 按文件名自动收录，无需改入口 — P1
  （2026-10-27 已完成 · 提交 `21ef1ab7`；后续 `4eca2288` / `ee86feb9` 按实测再分片，`18466ce8` 把 4 个小题合成 `08-misc`，整轮降到约 60s）
- [x] **界面检查每步都截全页图 + 每步最多等 1s 动画** — `check()` 每调用一次就 `screenshot()` 全页落盘（task 分片 121 张）；`settle()` 用 `Promise.race` 上 1000ms 兜底 — 证据：`scripts/ui/harness.mjs:141`、`scripts/ui/harness.mjs:98` — 建议：成功步骤不截、只失败与里程碑截（或 jpeg q60），`settle` 兜底降到 300ms — P1
  （2026-10-27 已完成 · 提交 `21ef1ab7`；截图 68MB → 1.8MB，断言条数不变）
- [x] **单测并发口径没落进脚本** — `test:unit` 用默认并发，已知会让计时类用例抖；串行要 3–5 分钟。真正吃时间的只有 4 个文件：`server/exec/worktree.test.ts` 46s、`server/exec/pi-rpc.test.ts` 16s、`server/task-store.test.ts` 5s、`server/exec/process.test.ts` 4s — 证据：`package.json:22`（无 `--test-concurrency`）、`server/exec/pi-rpc.test.ts:463`、`server/task-store.test.ts:154` — 建议：拆 `test:unit:timing`（串行）与 `test:unit:rest`（并行），`test:unit` 顺序跑两者 — P1（已完成：`scripts/unit-tests.mjs` 收口清单，计时文件 5 个（含 `background` 的名额用例）串行、其余 215 个文件并发；保留日志实测单轮 timing 64.6s + rest 99.8s ≈ 2m44s（另一轮 63.8s + 97.0s ≈ 2m41s），从改动前的 5m23s 降下来；全量用例 1849 = 原 1844 + 新增 5 条 `mcpConfig` 用例）
- [x] **worktree.test.ts 每个用例重建一次 git 仓库** — 31 个用例都走 `project()`：新目录 + `git init` + `add` + `commit`，单文件 46s ≈ 1.5s/用例 — 证据：`server/exec/worktree.test.ts:76` — 建议：模块级建一次模板仓库，每例 `cpSync` 复制（含 `.git`）— P1（已完成：模块级模板仓库 + `cpSync` 连 `.git` 复制，31 个用例不变；同机单跑 66.5s → 53.8s。未达清单写的 ~25s：建库成本已降到每例约 10ms，剩下的耗时在 31 例各自的 `createWorktree` 和用例内 commit / merge / 等锁，不是建库）
- [x] **Pi 桥接扩展的超时常量写死在定义里，测试只能真等** — 两条用例按设计等满 4000ms 与 8000ms，合计约 12s 纯等待 — 证据：`server/exec/pi-rpc.test.ts:449`、`server/exec/pi-rpc.test.ts:514`，常量源头 `shared/clis/pi.json` 里的 `STEP_TIMEOUT_MS = 4000` / `STEP_ATTEMPTS = 2` — 建议：模板里支持 `{stepTimeout}` / `{attempts}` 占位符，测试注入 300ms 并按注入值断言，生产值仍从 `shared/clis/pi.json` 取 — P1（已完成：模板改 `{stepTimeout}` / `{attempts}`，生产值在 `shared/clis/pi.json` 的 `mcp.vars`；测试注入 300ms / 2 次，两处用例 8s→0.67s、4s→0.35s，文件 16.9s→4.6s）
- [x] **e2e 并发不设上限，且与界面检查在 CI 里同时跑** — 已改：默认上限 4（`AGENT_PANEL_E2E_CONCURRENCY` 可覆盖，日志打印并发数，见 `scripts/lib/shard-limit.mjs`）；e2e 单 job 内默认最多 4 个分片；CI 里三个 job 本来就是各自独立的 runner，不需要串行 — 证据：`scripts/e2e.mjs`、`.github/workflows/ci.yml` — P1
- [ ] **`02b` 新块依赖「正好 5 个子对话」与前面留下的 localStorage 状态** — `scripts/ui/02b-subagent.mjs:902` 硬断言 `n !== 5`（「运行区列了 N 个子对话，应该和弹层一样是 5 个」），弹层条数 `:265` 的注释也写死「执行中 · 5 / 已完成 · 3」；改成「与弹层条数一致」会削弱断言强度，需要先找到等强的替代口径（例如按分组标题逐项对应）— 证据：`scripts/ui/02b-subagent.mjs:265`、`:902` — P2
- [ ] **界面检查高并发下的两条 flaky** — `10-toast.mjs`「关掉全部之后又冒出来 3 条」、`01-composer.mjs`「粘贴后输入框里没有出现会话卡片」；单跑均通过、默认并发全绿时偶发，属于时序断言而非功能错 — 证据：`scripts/ui/10-toast.mjs:130`、`:185`（存活 toast 计数）、`scripts/ui/01-composer.mjs:74`–`:93`（卡片 waitFor 后断言）— 建议：先查是 `waitFor` 超时偏短还是计数前未等队列 settle，再决定收紧等待还是拆步 — P2
- [ ] **e2e `04-subagents` 拆分以真正压低 wall** — 当前 e2e wall 由最慢单片决定，`04-subagents` 约 53.6s（交接实测，本轮未重测）— 证据：`scripts/e2e/04-subagents.mjs`、`scripts/e2e.mjs` 的分片汇总 — 建议：按「子对话派发 / 插话收尾 / 残留回归」再拆一片，注意各片共用的 fake-cli 输出目录要隔离 — P2
- [ ] **单测「Pi 初始化超时预算」余量只有 1000ms** — `server/exec/pi-rpc.test.ts:486` 断言 `waited < budget + 1000`，负载高时容易误报（该文件其余超时已按 `vars` 注入缩短）— 证据：`server/exec/pi-rpc.test.ts:486` — 建议：把余量改成按 budget 的比例（如 1.5 倍）或改用轮询到状态出现再断 — P2
- [ ] **`scripts/rules-check.mjs` 的编码检查会主动跳过前 8KB 含 NUL 的文件** — `scripts/rules-check.mjs:106` 仍是 `if (buf.subarray(0, 8000).includes(0)) continue`，文档里的裸 NUL 因此一直没被拦住 — 证据：`scripts/rules-check.mjs:106` — 建议：二进制判定改用扩展名白名单（图片/字体/压缩包），其余文件一律按文本检查 — P2
- [ ] **界面检查「分片与 covers 登记对不上」只打印提示、不影响退出码** — `scripts/ui-check.mjs:72`–`:81` 发现差异只 `console.log('提示：…')`；分片清单本身已对齐（当前 `scripts/ui/` 12 片，`ui-timings.json` 也是最近一次运行的 12 片快照），剩下的是校验不阻断 — 证据：`scripts/ui-check.mjs:72`、`:81`、`:163` — P2

## 四、体验与功能缺口

- [x] **删除对话彻底不可恢复** — 右键删除/批量删除会连子对话、worktree、上传附件、聊天工作目录一起物理删掉，只有一句「找不回来」— 证据：`server/tasks.ts:5549`、`web/src/components/layout/Sidebar.tsx:937` — 建议：默认进「回收站」（保留 7 天），入口放设置页「数据」— P0
  （2026-10-27 已完成 · 提交 `53f7d6c8`；删除改为标记删除 + 7 天保留，支持恢复/永久删除/过期清理）
- [x] **对话搜索只搜标题和第一条要求** — 找「那次聊过某个方案」只能凭标题猜 — 证据：`web/src/components/layout/SidebarTasks.tsx:163`；服务端无对话内容搜索路由 — 建议：加 `GET /tasks/search?q=`（扫 messages，返回命中片段），扩展现有命令面板搜索 — P1
  （2026-10-27 已完成 · 提交 `53f7d6c8`；新增 `GET /tasks/search` 与 `shared/task-search.ts`）
- [x] **工作总结把时间窗口写死成「今天」** — 想要「昨天的」「本周的」得自己改系统时间 — 证据：`shared/summary.ts:2`、`shared/summary.ts:141`、`web/src/pages/SummaryPage.tsx:202` — 建议：窗口抽成 `SummaryRange`（今天/昨天/近 7 天/自定义），服务端筛选与页面文案同一口径 — P1
  （2026-10-27 已完成 · 提交 `bb9ede59`；`SummaryRange` 支持今天/昨天/近 7 天/自定义，服务端与页面同一口径）
- [x] **计划只能「单次 / 每天」** — 想要「每周一总结」「工作日早上跑测试」只能建 5 条每天的计划 — 证据：`shared/schedule.ts:12`、`web/src/pages/SchedulesPage.tsx:142` — 建议：repeat 扩成 `once | daily | weekly | workdays`，`nextRun` / `groupOf` / 徽标同步 — P1
  （2026-10-27 已完成 · 提交 `bb9ede59`；`repeat` 四档，`weekly` 支持多选星期）
- [ ] **用量不能按项目/对话/角色拆** — 想知道「这个项目这周花了多少」「哪个子对话最贵」只能看按天汇总 — 证据：`shared/usage.ts:429`、`web/src/pages/SettingsPage.tsx:53` — 建议：`aggregateUsage` 加 `groupBy: 'project' | 'task'`，注意别出现第二个同名「费用」数字 — P1
  （2026-10-27 部分完成 · 提交 `bb9ede59`：已支持按项目/对话分组（`USAGE_GROUPS` 只有 time/project/task），**角色维度未做**，本条保持未勾）
- [ ] **没有跨项目的对话总览页** — 侧栏是「项目 → 对话」树、每项目默认 5 条，项目一多只能翻和搜 — 证据：`web/src/components/layout/Sidebar.tsx:103`、`web/src/components/layout/Sidebar.tsx:826` — 建议：加「对话」页（表格：项目/标题/状态/用时/token/最后活动，支持筛选与批量操作），复用现有 `matchTask` 与 `taskState` — P2
- [ ] **Chat 模式没有「导入任务」入口** — 导出的对话包只能在项目工作区导入 — 证据：`web/src/components/tasks/ProjectWorkspace.tsx:105`、`web/src/pages/ChatPage.tsx` — 建议：导入按钮提到通用工具栏，导入时 `projectId` 传空即落到聊天 — P2
- [ ] **设置页没有搜索** — 9 个分类、40 多个 Row，改「子对话默认也提问」这类项只能靠记忆翻 — 证据：`web/src/pages/SettingsPage.tsx:391`、`web/src/pages/SettingsPage.tsx:113` — 建议：分类导航顶部加过滤框，按 Row 的 title/desc 前端过滤并高亮命中分类 — P2
- [ ] **计划错过 / 启动失败不发系统通知** — 面板没开时计划错过只在计划页留一条徽标 — 证据：`web/src/lib/notify.ts:26`、`server/schedules.ts:29` — 建议：启动时把「错过的计划」作为事件推给前端，复用同一套 notify — P2
- [ ] **进程 / 内存清理入口太深** — 清残留进程要打开对话 → `ProcessMenu` → 勾选；内存曲线与 AI 分析在另一个弹窗 — 证据：`web/src/components/tasks/TaskView.tsx:51`、`MemoryChart.tsx:77` — 建议：设置页「系统」下加汇总入口，列出所有对话进程/内存，一键清理残留 — P2
- [ ] **缩略图链路的三处尾巴** — ① `server/thumbnail.ts:72`–`:79` 只在 `catch` 里 `rm` 临时文件，进程被杀会留 `*.tmp`；② 极长宽比图片 `Math.round((img.height * width) / img.width)`（`:69`）可能算成 0 高，需下限保护；③ `serialize()`（`:37`–`:39`）把缓存命中一起排队，命中时也要等前面解码完 — 证据：`server/thumbnail.ts:37`、`:69`、`:72`–`:79` — 建议：临时文件用定期清扫、高度取 `max(1, …)`、命中缓存的判断提到队列外 — P2
- [ ] **上下文降级的预算计算与二次降级** — ① `clippedTranscript` 里 `clipTokens(text, room)`（`server/exec/runner.ts:497`）没扣 `who` 前缀（父对话前缀更长）和「中间省略 N 个字」标记本身；② `toolLine`（`:432`–`:446`）的「等 N 项」用的是原始剩余长度，把被 `seen` 去重跳过的重复项也算进去；③ 降级重入后 `resume` 已删，`chatResume: Boolean(chat && resume)`（`:2200`）为 false，裁剪后 **再** 撞上限时不会再降级（`contextFallbackKind` 只对 `chatResume` 返回 `restart`）— 证据：`server/exec/runner.ts:404`–`:410`、`:432`–`:446`、`:497`、`:2200`、`:2229`–`:2231` — 建议：预算扣除前缀与标记、`rest` 用已收条数算、把「已经降级过一次」作为独立状态传下去 — P2

## 五、原已在处理中的三项（已完成）

- [x] 测试策略：增量测试 + 父对话跑全量 — 已完成：测试步骤 scope 三档（always / changed / parent）与 `scripts/changed-tests.mjs` 增量定位见 `c0f5c2f2`；从直接映射升级成影响面分析（import 依赖图 + 反向闭包、高风险区强制全量）见 `c851d22f`
  （2026-10-27 已完成 · 提交 `c0f5c2f2`、`c851d22f`）
- [x] 计划模块重设计（含滞后约束、新内容同步计划、重建 vs 增量规则）— 已完成：状态机（failed/skipped、唯一 running、终态判定）、事件自动推进、滞后与新输入检测见 `57208ae6`
  （2026-10-27 已完成 · 提交 `57208ae6`）
- [x] 对话页加载优化 — 已完成：SSE 增量 patch、`/children` 按状态分档与 15s TTL、首屏分页 `?limit=50` / `?before=` 翻页、`GET /tasks` 的 ETag/304、子对话计数共享缓存见 `87b0a6bf`；字体拆分（思源黑体按需加载）见 `cabcd372`
  （2026-10-27 已完成 · 提交 `87b0a6bf`、`cabcd372`）
