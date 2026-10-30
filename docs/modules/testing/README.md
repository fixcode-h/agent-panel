# testing：测试基础设施（单测 / 端到端 / 界面检查的编排）

- status: analyzed
- source_paths: `scripts/unit-tests.mjs`、`scripts/e2e.mjs`、`scripts/e2e/`、`scripts/ui-check.mjs`、`scripts/ui/`、`scripts/changed-tests.mjs`、`scripts/test-layers.mjs`、`scripts/test-budget.mjs`、`scripts/lib/changed-tests.test.mjs`、`scripts/lib/test-layers.test.mjs`、`scripts/lib/test-budget.test.mjs`、`scripts/lib/test-files.mjs`、`scripts/lib/`、`scripts/fake-cli/`
- entry: `scripts/unit-tests.mjs`、`scripts/e2e.mjs`、`scripts/ui-check.mjs`、`scripts/changed-tests.mjs`、`scripts/test-layers.mjs`、`scripts/test-budget.mjs`
- analyzed_at: 2026-10-28

## 职责

测试的**怎么跑、跑哪些、按什么并发跑**，不负责被测业务逻辑本身。

- 单测编排：按文件分批、计时文件串行、其余并发、按影响面只跑指定文件。
- 端到端编排：并行跑 `scripts/e2e/` 分片，每片独立数据目录、端口、假 CLI 日志。
- 界面检查编排：并行跑 `scripts/ui/` 分片，打开演示版检查报错、横向滚动并截图。
- 改动 → 测试选择：`scripts/changed-tests.mjs` 用 import 依赖图算反向闭包，输出要跑的单测文件、界面分片、是否必须全量。
- 分层与用例预算：`scripts/test-layers.mjs` 按运行时特征给每个测试文件归层并产出基线，`scripts/test-budget.mjs` 报各层用例数，只拦本次净新增（静态秒级；CI 用 tap 报实测数，出包时和上次发版对比）。
- 测试环境的默认值：语言环境、并发上限、临时目录、需要清理的继承变量。

## 分层边界与报数（本模块的核心口径）

| 层     | 判定                                                                                                                       | 入口                             | 预算                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------- |
| 纯函数 | 不启动服务、不建临时目录、不跑 git、不开子进程（批 0 基线：172 个文件 / 1500 例）                                          | `npm run test:unit` 的非集成文件 | 用例数上限             |
| 集成   | 起 Hono 服务、`mkdtemp` / 读写真实文件、执行 git、`spawn` / `execFile` 子进程、连真实 CLI（批 0 基线：80 个文件 / 722 例） | 同上                             | 用例数上限             |
| e2e    | `scripts/e2e/` 下由总入口调度的分片，用假 CLI 跑完整面板流程（批 0 基线：13 个分片 / 122 步）                              | `npm run test:e2e`               | 分片数与每片步骤数上限 |

判据只有一处：`scripts/lib/test-layers.mjs` 的 `INTEGRATION_MARKERS` 与 `layerOf(file, sourceText)`。命中任一条集成特征即归集成层；
同名 API 的同步与异步两种形态都算（`node:fs/promises` 的 `readFile` / `rm` 也算读写真实文件），但 `open(` / `link(` / `stat(` 这类短名不收——
测试里常是业务函数（如 `server/design-mcp.test.ts` 的 `open()`）。
e2e 分片只按目录归属（`scripts/e2e/` 下被总入口收集的 `NN-*.mjs`），不重复计入单测的两层。判据按源码文本匹配，
样例里写出 `spawn(` 一类调用的原文也会命中，所以分层判据自己的样例单独放在 `scripts/lib/test-layers.samples.mjs`。

分层基线用 `node scripts/test-layers.mjs --report` 产出（每个文件的层、命中特征、用例数与行数），加 `--out` 可写成 JSON；
当前基线（2026-10-27）见 change 目录的 `docs/openspec/changes/test-governance-budget-and-parallel-safety/evidence/test-layers.json`，
人工抽查 10 个文件的记录在同目录的 `evidence/test-layers.spot-check.md`。

各层用例总数**不设上限，只报数**（[ADR 0031](../../adr/0031-test-count-report-not-cap.md)，替代 ADR 0024 的硬预算）：

- `npm run lint` 跑 `node scripts/test-budget.mjs --check`：打出各层计数，再看**本次净新增**——工作区有测试改动时是工作区（提交说明用 `--message <文件>` 传），否则是 HEAD 这一个提交。
  净新增 = diff 里新增的用例行（单测 `test(` / `it(`、e2e 分片 `step(`）减去删掉的；改名、合并、删除都放行，净新增大于 0 时提交说明要有非空的 `测试预算:` 段写一句为什么加。合并提交不判（新增用例在被合进来的提交上判过）。
- CI 的 `test` job 在单测跑完后用 `--tap <报告>` 报实测用例数和静态计数的差，不拦，不重复跑测试。
- 出包时（`release.yml`）跑 `--report --since auto`，把各层用例数和上一个正式版逐项对比写进运行摘要。
- 重复、被覆盖、过时的用例定期派「测试验收」用 `task=清理用例` 一次列出一批候选，用户确认后再删（淘汰标准见 change 的 spec「Test retirement criteria」）。

并发、重试、迁移批次、验收命令的**规划**仍以 change `docs/openspec/changes/test-governance-budget-and-parallel-safety/` 为准（`design.md` 的 D4–D11）；
分层和报数的代码已经落地（本文上面两段），迁移批次（改 `*.integration.test.ts` 后缀、拆文件、淘汰用例）还没做。
输出、失败重跑已经落地（见下面「输出、失败重跑和预算」），自适应并发还没做。

## 分片结构

- 端到端：`scripts/e2e/01-settings.mjs` 到 `scripts/e2e/14-accounts.mjs`（当前 13 个分片，编号 01–08、10–14，没有 09）；总入口按 `^\d+-.*\.mjs$` 收集，可传前缀只跑部分（`npm run test:e2e -- 03 07`）。
- 界面检查：`scripts/ui/01-composer.mjs` 到 `10-toast`（12 个分片，任务页拆成 `02` / `02b` / `02c` / `02d`）；分片覆盖的源码前缀登记在 `scripts/ui/covers.mjs`。两层校验不同：分片文件能否被 `scripts/ui-check.mjs` 的 `SHARD_FILE` 收录、截图前缀能否认得出是**硬门禁**（`scripts/rules-check.mjs` 第 14 条，对不上 `npm run lint` 失败）；`covers.mjs` 的登记对不上只打一句提示、不影响本次结果（有意保留，允许加片和补映射分两次提交，代价是改到对应源码时增量选择映射不出来）。
- 两者都是「一个分片一个进程」：自己的服务、浏览器、临时数据目录，分片之间不能有依赖。

## 怎么跑

| 目的                             | 命令                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| 全量单测                         | `npm run test:unit`（只打结论、失败详情、抖动和最慢的文件；完整 TAP 在 `logs/tests/`） |
| 只复测上次失败的单测文件         | `npm run test:failed`                                                                  |
| 看完整输出                       | `npm run test:unit -- --verbose`，或读 `logs/tests/unit-*.tap`                         |
| 失败不重跑（排查抖动）           | `npm run test:unit -- --no-retry`                                                      |
| 只跑指定单测文件                 | `node scripts/unit-tests.mjs --files a.test.ts,b.test.ts`                              |
| 只跑计时文件（串行）             | `npm run test:unit:timing`                                                             |
| 按影响面跑增量                   | `npm run test:affected -- --since <任务基线>`                                          |
| 全量端到端（Windows 必须走 WSL） | `npm run test:e2e:wsl`（走 WSL 默认发行版；默认发行版必须是 Ubuntu-24.04）             |
| 只跑部分端到端分片               | `npm run test:e2e -- 03 07`                                                            |
| 全量界面检查                     | `npx vite build --mode demo && node scripts/ui-check.mjs`（不先构建会被拦下）          |
| 只跑部分界面分片                 | `node scripts/ui-check.mjs 08-misc`                                                    |
| 只复测上次失败的分片             | `npm run test:e2e -- --failed`、`node scripts/ui-check.mjs --failed`                   |
| 各层用例数                       | `node scripts/test-layers.mjs --report`（检查随 `npm run lint` 跑）                    |
| 改动 → 要跑什么                  | `node scripts/changed-tests.mjs --since <基线>`                                        |

## 怎么加用例

1. **先查重**：在同名 / 相邻测试文件和 `scripts/ui/` 里搜这条断言；同一行为只断言一处。
2. **先判层**：会起服务、读写真实文件、跑 git、开子进程的写法属于集成层；纯逻辑进纯函数层。不要为了省事把集成用例塞进纯函数文件。
3. **写验证命令**：新用例所属的入口（单测 / e2e / 界面）就是它的验证命令；改界面检查要重新构建演示版。
4. **断言不依赖语言**：用 `t()` 或语言无关标识，不写死中文（教训 `lmvq64pdbulcy`）。
5. **加了就写理由**：净新增用例时提交说明写「测试预算:」一句话（覆盖了什么、为什么现有用例覆盖不到）；能合进已有用例的先合；不能因为「跑得慢」删测试。
6. **加 e2e 分片**：场景放 `scripts/e2e/` 下的 NN-主题.mjs，调 `runShard()`；临时目录、端口、服务、看门狗都在 `harness.mjs` 的 `setupBase()` 里，别在分片里自己起服务或写死端口。加界面分片还要登记 `scripts/ui/covers.mjs`。

## 回放录像

假 CLI 有回放模式（`scripts/fake-cli/replay.mjs`）：`FAKE_REPLAY=<录像.jsonl>`，或者 e2e 用例把录像路径写进 `<FAKE_CLI_LOG>.replay-src`，Claude Code 的每次执行按录像回放下一轮（到 `result` 为止，带 `_t` 时按原间隔 10 倍速吐），录像用完再被调用报错。录像可以是真实 CLI 的原始输出（`server/exec/fixtures/claude-stream.jsonl`，`03-chat` 里回放它），也可以用 `node scripts/replay-from-export.mjs` 从面板导出的对话包转出来（`scripts/lib/replay-export.mjs`）。转出来的录像只复现事件顺序和时序，面板自己的工具不会真的被调用。

## 输出、失败重跑和报数（[ADR 0024](../../adr/0024-test-output-retry-budget.md)、[ADR 0031](../../adr/0031-test-count-report-not-cap.md)）

- **输出**：单测入口用自定义 reporter（`scripts/lib/test-reporter.mjs`）出结构化事件，终端只打每批结论、失败详情（每条最多 20 行）、抖动、慢用例（单条 > 2s）和最慢的 5 个文件；完整 TAP 写进 `logs/tests/unit-*.tap`。一次全量从约 50 万字节降到 3KB 左右。端到端、界面检查本来就只在失败时打全量输出。
- **失败只重跑失败的**：单测失败的文件串行重跑，总共最多 3 次（`scripts/lib/test-results.mjs` 的 `MAX_ATTEMPTS`）；端到端、界面检查失败的分片串行再跑一次（`scripts/lib/shard-retry.mjs`）。重跑通过的记成「抖动」，醒目打出来、写进 `logs/tests/*-last.json`，退出码按最后一次算。抖动要去修（注入时钟、事件驱动、放宽到实测 p99 两倍），不能靠重跑兜着。
- **抖动报告**：三个入口都把抖动的单元（试了几次、第一次报的什么错）写进同一份 `logs/tests/flaky-report.json`，每次用自己这一类整份替换（没有抖动就清空这一类，旧报告不会把干净的一次判红）。CI 的 test job 跑完单测后跑 `node scripts/flaky-check-report.mjs`：有抖动就判红，不只看退出码（`scripts/lib/flaky-report.mjs`）。
- **改完只复测失败的**：还失败的记在 `logs/tests/unit-last.json` / `e2e-last.json` / `ui-last.json`，`npm run test:failed`、`--failed` 只跑它们。
- **继承环境**：单测、端到端、界面检查起进程前去掉 `ANTHROPIC_*`、`OPENAI_*`、`CLAUDE_CODE_*` 这类会改变 CLI 行为的变量，面板自己的 `AGENT_PANEL_*`（测试入口的开关 `AGENT_PANEL_UNIT_*` / `E2E_*` / `UI_*` 保留）和 `GIT_CONFIG_*`、`GIT_DIR` 这类 git 变量，日志里按前缀列出去掉了哪些（`scripts/lib/test-env.mjs`）。分片额外带 `AGENT_PANEL_E2E_SHARD_ID` / `AGENT_PANEL_UI_SHARD_ID`。
- **并发**：三个入口都用 `scripts/lib/concurrency.mjs` 的 `suggestConcurrency`，CPU、可用内存（`process.availableMemory`，会算进 cgroup；每个单元按单测 120M、e2e 600M、界面 500M 估，只用 70%）和单元数取小，e2e 另有默认上限 4，日志打印「并发 N，由哪一项决定」。只管测试进程，和面板里对话的执行无关；用户 2026-10-30 定为一直开着、不设开关。`AGENT_PANEL_UNIT_CONCURRENCY` 写了就照它开（调试用）；`AGENT_PANEL_E2E_CONCURRENCY` 和 `AGENT_PANEL_UI_CONCURRENCY` 只能再往下压，写大了日志会写明没用上。
- **用例报数**：见上面「分层边界与报数」；总数不设上限，`npm run lint` 只拦本次净新增（要写「测试预算:」理由），清理靠「测试验收」的「清理用例」定期一批做。
- **串行清单**：`TIMING_FILES` 仍是最后手段，进清单要有证据；串行不等于稳定（`server/background.test.ts` 在串行批里也超过窗口）。

## 依赖

Node.js 20+、`tsx`（单测执行器）、Playwright chromium（界面检查）。端到端需要 macOS / Linux；Windows 用 `npm run test:e2e:wsl`（走 WSL 默认发行版，默认发行版必须是 Ubuntu-24.04），不能在 PowerShell 里直接跑。需要显式指定发行版时，`bash -lc` 会落到 `$HOME`，命令里必须显式 `cd` 到工作区。

## 回归验证

- 改了编排脚本：`npm run test:unit` 里对应的 `scripts/lib/*.test.mjs`，加上一次全量 `npm run test:unit`。
- 改了分片或 `covers.mjs`：`npm run lint`（分片登记与文档一致性），再跑受影响分片。
- 改了界面检查：先 `npx vite build --mode demo`，再跑对应分片，看 `ui-shots/`。
- 改了并发或环境默认值：分别在显式环境变量与默认值下各跑一次，核对日志里的并发值 / locale。

## 待确认

- 分层后缀（`*.integration.test.ts`）、用例级影响面选择、默认英文环境、验收入口（`verify-local` / `flaky-check` / `ci-timings`）仍在 change `test-governance-budget-and-parallel-safety` 里，没有实现；已经落地的是输出、重跑、报数（ADR 0024 / 0031）和 2026-10-30 的自适应并发、继承环境清理、抖动报告。
- e2e 默认上限 4、各单元的内存估算是经验值。
