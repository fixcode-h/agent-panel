# scripts：端到端测试、界面检查、出包和检查脚本

- status: inferred
- source_paths: `scripts/`
- entry: `scripts/e2e.mjs`、`scripts/ui-check.mjs`、`scripts/package.mjs`、`scripts/rules-check.mjs`
- analyzed_at: 2026-10-24

## 职责

- 端到端测试：`scripts/e2e.mjs` 并行跑 `scripts/e2e/` 下的分片，每个分片自己的临时数据目录、假 CLI 日志、端口和服务，默认最多同时跑 4 个（`AGENT_PANEL_E2E_CONCURRENCY` 可覆盖）；共享环境在 `scripts/e2e/harness.mjs`，启动服务走 `scripts/e2e/spawn-server.mjs`（服务自己 `listen(0)` 报回实际端口、`/health` 回显分片唯一的 instance，端口被残留进程或并行分片占着时明确失败）。服务启动后在 stdout 打一行 `AGENT_PANEL_PORT <实际端口>`，是给测试和脚本解析用的，托盘程序只看 `AGENT_PANEL_READY` / `OPEN` / `FOCUS` / `UPDATE`。
- 模拟 CLI：`scripts/fake-cli/fake-cli.mjs` 按场景输出各 CLI 的结构化事件（含 RPC 多轮），`fake-npm.mjs` 模拟安装 / 卸载。
  - 插话契约：假 CLI 收到插话（Codex 和 Command Code 的 `turn/steer`、Pi 的 `steer`、Claude Code 执行中写进来的 user 消息）时，不能只记进 `steered` 就完事，要像真 CLI 一样当场把插话里的【收尾请求】办掉：`takeSteer()` 先用 `wrapRequestIds(text)`（`scripts/fake-cli/wrap-request.mjs`）按 id 去重取出子对话 id，逐个 `panelCall('finish_child', { id })`，结果追加到 `${FAKE_CLI_LOG}.finish`（带 `via: 'steer'`，本轮 input 那条路写 `via: 'input'`，用例据此分清哪条路办的）；`tookWrap` 按**轮**去重（每处开始新一轮时 `tookWrap.clear()`，因为保活的进程会接着跑很多轮，按进程记的话子对话被退回后第二次请收尾会被静默跳过），原 input 和插话都带同一个请求时只合一次。原因：父对话正在跑一轮时，子对话的 `submit_merge` 经 `server/tasks.ts` 的 `noteParent → steerTask` 以插话进入那一轮，不会再另开一轮；假 CLI 只 push 不处理的话 `finish_child` 永远不会被调用，子对话一直停在收尾请求待处理，e2e 里等 `resolved && worktree.state === 'merged'` 的步骤只能等到超时（并行分片时父对话常被前一个子对话的上报叫起，必现）。这是测试替身失真（真 CLI 收到插话会照做），不是产品 bug，别用调大超时绕过。用例要这条路径时给父对话发 `HOLD_STEER`：这一轮一直挂到真的收到带【收尾请求】的插话才收尾（别的插话，比如子对话状态上报先到，不算数，不然这一轮会被提前放掉；兜底上限 60 秒，和用例等合回的时间对齐），不靠 `SLOW` 那段固定时长（那个窗口常被子对话开分支、派评审的链路超过，收尾请求会退化成普通新一轮 input，让用例假通过）。`HOLD_STEER` 等待期间必须一直有输出（用 thinking 事件模拟，间隔 1 秒）：面板按「交出消息后多久没有任何输出」判卡住（`AGENT_PANEL_NO_RESPONSE_MS`，e2e 里 2 秒），静默等会被判成卡住，之后来的消息改走 `restartStalled` 停掉这一轮重开，收尾请求就不再是插话了。
- 界面检查：`scripts/ui-check.mjs` 用 Playwright 打开在线演示版，检查报错和横向滚动，截图到 `ui-shots/`；分片在 `scripts/ui/`，每个分片覆盖的源码前缀表在 `scripts/ui/covers.mjs`（新增分片时同步）。分片名可以是 `02` 也可以是 `02b`、`02c`（同一个主题拆成几片），总入口按 `^\d+[a-z]?-` 收录；任务页的三个分片（`02-task` 核心对话页 / `02b-subagent` 子对话与运行视图 / `02c-element-pick` 抓取、计划、进程与询问）共用 `scripts/ui/task-page.mjs` 的开场与常用操作，三片各自 `openCartTask` 重建前置状态、互不依赖，`covers.mjs` 里三片登记同一批任务页源码（改一个任务页组件三片都跑，宁多跑不漏跑）。截图默认只拍分片第一步和出错的步骤（`SHOTS=all` 或总入口 `--verbose` 才每步都拍），格式 jpeg（`harness.mjs` 的 `SHOT_TYPE` / `SHOT_QUALITY`），所以全量跑只有几十张而不是每步一张；`settle()` 等有限动画的兜底是 300ms。两个入口启动时都会校验 `dist-demo` 和源码对得上（指纹在 `scripts/lib/demo-build-info.mjs`，`vite build --mode demo` 时写进产物），源码改过却没重新构建时直接失败并列出变了的文件，不拿旧产物跑出假结果。
- 出包：`scripts/package.mjs` 把正式版前端和单文件服务端放进 `release/`，并检查包里没有演示内容；Windows 托盘程序在 `scripts/tray/`，服务安装脚本在 `scripts/service/`。
- 发布：`scripts/release-publish.mjs` 负责 `.github/workflows/release.yml` 里「发布到 Releases」这一步：创建 GitHub Release、上传 5 个产物、标 `--latest`，并对瞬时失败重试（HTTP 5xx、超时、连接层错误，gh（Go）侧的 `no such host` / `context deadline exceeded` 这类网络、超时文本也算瞬时错误，退避 5s / 15s / 30s，最多 4 次尝试；4xx 不重试、直接失败并保留原始报错）。每次重试前先 `gh release view` 确认上一次是不是其实已经建成（504 是服务端超时，资源可能已创建）：已存在且产物齐全按成功处理并在日志写明，缺产物用 `gh release upload --clobber` 补齐（按资产名和字节数比对，同名但大小不对也算缺），查询本身撞 5xx 时不会冒然创建。起因和完整规则见脚本开头的注释。
- 检查：`scripts/rules-check.mjs`（CLI 名字分支、文档路径、教训分片格式、换行和编码等）、`scripts/i18n-check.mjs`（漏翻）、`scripts/lessons.mjs`（按改动文件取教训）、`scripts/release-notes.mjs`（整理更新说明）。
- 模块文档一致性：`scripts/lib/doc-modules.mjs` 解析 `docs/MODULE-MAP.md` 的模块表，检查模块表与 `docs/modules/*` 双向对得上（缺文档、模块删了还留目录）；`scripts/rules-check.mjs` 调用它，用例在 `scripts/doc-modules.test.mjs`。
- 真实 CLI 验证：`scripts/real-cli/` 用本机真实 CLI 跑一遍（不是每次都要跑）。

## 入口

- `npm run test:unit`：单测，按 `scripts/unit-tests.mjs` 分两批顺序跑：计时文件（真实时钟断言，清单在脚本顶部）串行（`--test-concurrency=1`），其余文件并发（核数 × 1.5，文件多半在等定时器和子进程，比 node 默认的「核数 - 1」快约三成；`AGENT_PANEL_UNIT_CONCURRENCY` 可改）；`npm run test:unit:timing` / `npm run test:unit:rest` 单独跑某一批；`scripts/unit-tests.mjs --files a.test.ts,b.test.ts` 只跑指定文件（同一套 timing / rest 分批，不认识的路径直接失败）。计时文件新增或改名时同步脚本里的清单，路径对不上会直接失败。
- `npm run test:e2e`：端到端；只跑某几个分片 `npm run test:e2e -- 03 07`。
- `npx vite build --mode demo && node scripts/ui-check.mjs`：界面检查（必须先构建，产物旧了会失败）；只跑部分分片加筛选参数，例如 `node scripts/ui-check.mjs 08-misc`。
- `node scripts/changed-tests.mjs --since <任务基线>`：改动 → **影响面** → 要跑的单测文件和界面检查分片（按 import 依赖图求反向闭包，含间接依赖；高风险区、影响面过宽、依赖图算不出来时直接建议全量并说明理由）。子对话只跑增量，全量交给父对话；定位规则在 `scripts/lib/import-graph.mjs` + `scripts/lib/changed-tests.mjs` 并有单测，见 [ADR 0020](../../adr/0020-test-scope-and-incremental-tests.md)。`npm run test:affected` = 同一个脚本加 `--run`，按结论直接跑单测。
- `npm run lint`：oxlint、Prettier 格式检查、规则检查。
- `npm run package`：出包。
- `node scripts/release-publish.mjs <版本号> --target <sha> --notes-file <路径> --asset <文件> [--asset <文件> ...]`：发布 GitHub Release（版本号可带 `v` 前缀），由 `release.yml` 在出包后调用，一般不用手动跑。

## 依赖

Playwright（界面检查）、esbuild（出包）、Node.js 20+。端到端测试需要 macOS / Linux；Windows 上用 `npm run test:e2e:wsl`。

## 回归验证

- 改了端到端：`npm run test:e2e`（CI 里跑同样的命令）。
- 判「节点并发 / 先后」用引擎记的节点时间，不看假 CLI 进程的 `start` / `end`：`step.startedAt` 在 `shared/engine.ts` 的 `runNodeSingle` 里 spawn **之前**记、`step.endedAt` 在节点结束时记，合起来是「节点执行窗口」（`runFlow` 同一阶段顺序 `for (const n of ready())` 塞进 `running` 再 `Promise.race`，两个节点的 `startedAt` 落在同一毫秒附近）；假 CLI 的 `start` 是 node 进程起来写日志的时刻、`end` 是进程退出时刻，那是「进程存活窗口」。CI 上多个分片并行时（默认最多同时 4 个），同一阶段第二个节点的进程可能晚到第一个 exit 之后才写日志，两个进程窗口就不重叠了，但引擎确实并发调度了（`02-workflow.mjs` 的「同一阶段的两个节点应该同时运行」以前会因此假失败）。反过来，真串行时下游的 `startedAt` 会晚于上游的 `endedAt`，节点时间照样能拦住。断言失败时消息里同时打印两种窗口，一眼能看出是调度真串行还是进程启动慢。验证这类改动用对照实验：`FAKE_STARTUP_DELAY_MS` / `FAKE_STARTUP_DELAY_MATCH`（`fake-cli.mjs`，默认关）只拖慢匹配节点的进程启动，旧断言必须失败、新断言必须通过。
- 读假 CLI 写在 `FAKE_CLI_LOG + '.xxx'` 里的调用记录用 `scripts/e2e/read-log.mjs` 的 `readLog`：它会丢掉末尾正在追加写、还没写完的那一行（否则 `JSON.parse` 抛 `Unterminated string`，整个分片失败在和断言无关的地方），中间行损坏仍然报错，用例在 `read-log.test.mjs`。丢掉的那行写完后正好排在原位置，所以「先读 length 当基线再 slice」的写法不会错位。
- 要断言 `resolved` / `worktree.state === 'merged'` 这类状态位对应的假 CLI 记录（`.finish`、`.hold`）前，先确认记录已经落盘：状态位是服务端在 `finish_child` 返回时就置位的，而记录是假 CLI 等到 HTTP 响应回来后才追加写，两者之间有窗口（CI 负载下更大）。用 `waitFor` 等记录本身出现，等不到再失败并打印全部条目（`04-subagents.mjs` 的「父对话正在跑一轮时子对话请收尾」曾因此假失败）。对照实验用 `FAKE_FINISH_LOG_DELAY_MS`（默认 0）把落盘拖后，旧写法必须失败、新写法必须通过。
- 要测「停止」的用例，先 `waitFor` 到假 CLI 真的跑起来了再 `stop`（`03-chat.mjs` 的停止、`07-local.mjs` 的重命名）：建完任务立刻 stop，那一轮（`FAKE_TURN_MS` 默认 150ms）可能已经跑完、任务已是 `done`，stop 成了 no-op，断言 `stopped` 会假失败。
- 断言时间字段（`updatedAt` 这类每次落盘由 `new Date()` 现取的值）不要用 `assert.equal` 比字符串：两次落盘路径各自取时间，分片并行、负载高时会差 1~2ms（`07-local.mjs` 的「预热退出不改列表时间」实测正常 0ms、曾出现过 1ms）。改成比时间差在容差内，容差取「毫秒抖动拦不住、真实变化跑不掉」的量级：`07-local.mjs` 用 `UPDATED_AT_TOLERANCE_MS = 200`，因为真出错时列表时间会晚至少一个 presence 宽限期（e2e 里 `AGENT_PANEL_PRESENCE_GRACE_MS=1200`）。反向验证：把比较用的基准时间人为改早 2 秒，断言必须报错（`AssertionError: 预热退出不改列表时间（差了 2000ms，容差 200ms）`）。反过来，比「字段有没有被重写回原值」的地方（`turnDoneAt`、`checkedAt`）不涉及重新取时间，仍然用 `assert.equal`。
- 改了假 CLI 的插话或收尾处理（`fake-cli.mjs` 的 `takeSteer()`、`wrapRequestIds()`）：`npm run test:e2e -- 04`，其中「父对话正在跑一轮时子对话请收尾：收尾请求以插话进来，父对话照样合回」一步专门覆盖插话里带【收尾请求】的路径：给父对话发 `HOLD_STEER` 让它真的一直跑到插话进来，断言子对话在 60s 内 `resolved && worktree.state === 'merged'`、`.finish` 里那条记录 `via === 'steer'`（只写 `via: 'input'` 就说明收尾请求退化成普通新一轮，插话路径没被覆盖）、`.hold` 记了 `held: true`（那一轮真的等到插话，不是静默被当成卡住）。把 `takeSteer()` 里处理收尾请求的部分去掉，这一步会以 `超时：done` 失败。
- 改了界面检查：先 `npx vite build --mode demo`，再 `node scripts/ui-check.mjs`，看 `ui-shots/` 里的截图（改了 `web/src`、`shared` 后没重新构建会被拦下）。
- 改了检查脚本：`npm run lint`；改了出包：`node scripts/package.mjs 0.0.0 --no-archive` 试跑一次。
- 改了发布逻辑：`npx tsx --test scripts/release-publish.test.mjs`（`npm run test:unit` 也会收集 `scripts/**/*.test.mjs`）。单测用假的 `exec` / `sleep` 覆盖 504→重试成功、4xx→不重试、已存在但缺产物→补齐、重试耗尽、查询撞 5xx 这几条路径。

## 待确认

- 出包和托盘程序的完整验证在 CI 的 Windows job 里（见 `.github/workflows/ci.yml`），本机无法完整复现（待确认）。
