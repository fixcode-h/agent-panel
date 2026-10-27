# testing：测试基础设施（单测 / 端到端 / 界面检查的编排）

- status: analyzed
- source_paths: `scripts/unit-tests.mjs`、`scripts/e2e.mjs`、`scripts/e2e/`、`scripts/ui-check.mjs`、`scripts/ui/`、`scripts/changed-tests.mjs`、`scripts/lib/changed-tests.test.mjs`、`scripts/lib/`、`scripts/fake-cli/`
- entry: `scripts/unit-tests.mjs`、`scripts/e2e.mjs`、`scripts/ui-check.mjs`、`scripts/changed-tests.mjs`
- analyzed_at: 2026-10-27

## 职责

测试的**怎么跑、跑哪些、按什么并发跑**，不负责被测业务逻辑本身。

- 单测编排：按文件分批、计时文件串行、其余并发、按影响面只跑指定文件。
- 端到端编排：并行跑 `scripts/e2e/` 分片，每片独立数据目录、端口、假 CLI 日志。
- 界面检查编排：并行跑 `scripts/ui/` 分片，打开演示版检查报错、横向滚动并截图。
- 改动 → 测试选择：`scripts/changed-tests.mjs` 用 import 依赖图算反向闭包，输出要跑的单测文件、界面分片、是否必须全量。
- 测试环境的默认值：语言环境、并发上限、临时目录、需要清理的继承变量。

## 三层边界（本模块的核心口径）

| 层     | 判定                                                                                                  | 入口                                     | 预算                       |
| ------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------- |
| 纯函数 | 不启动服务、不建临时目录、不跑 git、不开子进程                                                        | `npm run test:unit` 的非集成文件         | 按用例数设上限             |
| 集成   | 起 Hono 服务、`mkdtemp`、执行 git、`spawn` 子进程、连真实 CLI（`server/` 下 72 个测试文件含这类特征） | 同上，文件名后缀 `*.integration.test.ts` | 按用例数设上限             |
| e2e    | `scripts/e2e/` 下由总入口调度的分片，用假 CLI 跑完整面板流程                                          | `npm run test:e2e`                       | 按分片数与每片步骤数设上限 |

分层、预算、并发、重试的**规划**见 change `docs/openspec/changes/test-governance-budget-and-parallel-safety/`（`design.md` 的 D1–D11）。在该 change 合入前，代码里仍是现状：没有 `*.integration.test.ts` 后缀、没有预算脚本、没有自适应并发。

## 分片结构

- 端到端：`scripts/e2e/01-settings.mjs` 到 `scripts/e2e/14-accounts.mjs`（当前 13 个分片，编号 01–08、10–14，没有 09）；总入口按 `^\d+-.*\.mjs$` 收集，可传前缀只跑部分（`npm run test:e2e -- 03 07`）。
- 界面检查：`scripts/ui/01-composer.mjs` 到 `10-toast`（12 个分片，任务页拆成 `02` / `02b` / `02c` / `02d`）；分片覆盖的源码前缀登记在 `scripts/ui/covers.mjs`。两层校验不同：分片文件能否被 `scripts/ui-check.mjs` 的 `SHARD_FILE` 收录、截图前缀能否认得出是**硬门禁**（`scripts/rules-check.mjs` 第 14 条，对不上 `npm run lint` 失败）；`covers.mjs` 的登记对不上只打一句提示、不影响本次结果（有意保留，允许加片和补映射分两次提交，代价是改到对应源码时增量选择映射不出来）。
- 两者都是「一个分片一个进程」：自己的服务、浏览器、临时数据目录，分片之间不能有依赖。

## 怎么跑

| 目的                             | 命令                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| 全量单测                         | `npm run test:unit`                                                           |
| 只跑指定单测文件                 | `node scripts/unit-tests.mjs --files a.test.ts,b.test.ts`                     |
| 只跑计时文件（串行）             | `npm run test:unit:timing`                                                    |
| 按影响面跑增量                   | `npm run test:affected -- --since <任务基线>`                                 |
| 全量端到端（Windows 必须走 WSL） | `npm run test:e2e:wsl`（走 WSL 默认发行版；默认发行版必须是 Ubuntu-24.04）    |
| 只跑部分端到端分片               | `npm run test:e2e -- 03 07`                                                   |
| 全量界面检查                     | `npx vite build --mode demo && node scripts/ui-check.mjs`（不先构建会被拦下） |
| 只跑部分界面分片                 | `node scripts/ui-check.mjs 08-misc`                                           |
| 改动 → 要跑什么                  | `node scripts/changed-tests.mjs --since <基线>`                               |

## 怎么加用例

1. **先查重**：在同名 / 相邻测试文件和 `scripts/ui/` 里搜这条断言；同一行为只断言一处。
2. **先判层**：会起服务、读写真实文件、跑 git、开子进程的写法属于集成层；纯逻辑进纯函数层。不要为了省事把集成用例塞进纯函数文件。
3. **写验证命令**：新用例所属的入口（单测 / e2e / 界面）就是它的验证命令；改界面检查要重新构建演示版。
4. **断言不依赖语言**：用 `t()` 或语言无关标识，不写死中文（教训 `lmvq64pdbulcy`）。
5. **不涨无预算**：超预算时同一次提交合并或淘汰等量旧用例，写清覆盖关系；不能因为「跑得慢」删测试。
6. **加 e2e 分片**：场景放 `scripts/e2e/` 下的 NN-主题.mjs，调 `runShard()`；临时目录、端口、服务、看门狗都在 `harness.mjs` 的 `setupBase()` 里，别在分片里自己起服务或写死端口。加界面分片还要登记 `scripts/ui/covers.mjs`。

## 失败怎么处理

- 单测计时类用例偶发失败时，**只重跑失败的那个文件**，最多 3 次尝试；3 次仍失败按真失败处理，把用例名和输出写进结果，不要重跑整套。
- 反复失败且依赖真实时钟的文件进 `TIMING_FILES` 串行清单，但每个条目要有证据（断言位置 + 失败记录）；清单不是并发问题的首选修复手段。
- **串行 ≠ 稳定**：清单只降低与其他测试文件抢 CPU 的概率，不能消除真实时钟漂移——`server/background.test.ts` 的 `Date.now()` 窗口断言曾在串行批里以 5599ms 超 4000ms 失败。这类断言要先按 change 的 `test-execution-stability` 规范改造（注入时钟 / 事件驱动 / 窗口 ≥ 实测 p99 的 2 倍），再谈移出清单；不要用「换个批次」收尾。
- e2e / 界面检查失败先看分片名和它自己的数据目录，再决定重跑那一片；不要整轮重跑。

## 依赖

Node.js 20+、`tsx`（单测执行器）、Playwright chromium（界面检查）。端到端需要 macOS / Linux；Windows 用 `npm run test:e2e:wsl`（走 WSL 默认发行版，默认发行版必须是 Ubuntu-24.04），不能在 PowerShell 里直接跑。需要显式指定发行版时，`bash -lc` 会落到 `$HOME`，命令里必须显式 `cd` 到工作区。

## 回归验证

- 改了编排脚本：`npm run test:unit` 里对应的 `scripts/lib/*.test.mjs`，加上一次全量 `npm run test:unit`。
- 改了分片或 `covers.mjs`：`npm run lint`（分片登记与文档一致性），再跑受影响分片。
- 改了界面检查：先 `npx vite build --mode demo`，再跑对应分片，看 `ui-shots/`。
- 改了并发或环境默认值：分别在显式环境变量与默认值下各跑一次，核对日志里的并发值 / locale。

## 待确认

- 分层后缀、预算脚本、自适应并发、重试与 flaky 报告、验收入口（`verify-local` / `flaky-check` / `ci-timings`）都在 change `test-governance-budget-and-parallel-safety` 里规划，尚未实现；实现后本节和上面「三层边界」的现状描述要一起更新。
- `AGENT_PANEL_E2E_CONCURRENCY` 默认 4 是经验值，新的内存计算落地后要重新实测每分片峰值内存并回填常量。
