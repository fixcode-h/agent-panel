# Proposal

## Why

项目的测试只增不减：2119 个「单测」里混着大量起服务、建临时目录、跑 git、开子进程的集成级用例，本地六步整体验证已经要 6 分 5 秒，CI 的 test job 上限 30 分钟；偶发失败靠 `TIMING_FILES` 串行清单和压并发兜底，清单本身在膨胀（今天 `server/files.test.ts`、`worktree.test.ts` 计时失败）；`scripts/changed-tests.mjs` 又经常判「必须全量」，让增量筛选失去意义。再这样下去，加测试会变成改不动代码的主要原因。

这次把测试当成有预算的工程资产来治理：分层、设硬预算、按机器能力并发、让失败可归因，并把验收标准写成能直接跑的命令。

## What Changes

- **测试分层与预算**：定义纯函数 / 集成 / e2e 三层的判定标准与各层耗时上限；把 2119 个「单测」里起 Hono 服务、临时目录、跑 git、开子进程的用例重新归层；每层设用例数硬上限，超预算必须合并或淘汰等量旧用例。
- **flaky 隔离与自动重试**：失败先按文件隔离重跑、最多 3 次，给出 flaky 判定与记录流程；收缩 `TIMING_FILES` 串行清单，要求每个条目有真实时钟证据。归因已按实测校正：`server/background.test.ts` 的计时断言在串行批里也以 5599ms 超 4000ms 窗口失败，说明这类 flaky 是「靠真实时钟轮询」而不是被其它文件抢 CPU，串行只能降低争用概率；替代机制是断言侧改造（注入时钟 / 事件驱动 / 窗口 ≥ 实测 p99 的 2 倍）加隔离重跑，不是继续往清单里加文件。
- **并行度自适应**：单测、e2e、界面检查统一按 CPU 核数、可用内存和单元内存估算计算并发，显式环境变量作为上限；消除界面 12 分片全并发 `page.goto` 30 秒超时、e2e 分片抢端口和 `DATA_DIR`。
- **语言环境默认化**：默认与 CI 一致的语言环境由父对话在 runner 侧实施（改 `scripts/unit-tests.mjs` 的 locale、接入 `AGENT_PANEL_LANG`）；本 change 只做断言语言无关化与中文硬编码断言检查，执行前告知父对话。
- **影响面筛选细化**：`scripts/changed-tests.mjs` 减少无依据的「必须全量」，细化到用例级影响面，输出可复核的命中理由。
- **过期用例淘汰规则**：只允许「被测能力已删除 / 被更强断言完全覆盖 / 长期 flaky 且修复成本高于价值」三类理由，禁止为缩短时间删测试。
- **验收命令与模块文档**：提供一条命令跑本地六步并输出每步与总耗时、一条命令连续跑全量判定 flaky；补 `docs/modules/testing/README.md` 并登记进 `docs/MODULE-MAP.md`。

## Capabilities

### New Capabilities

- `test-layering-and-budget`：测试分层判定、各层用例硬预算、淘汰规则、六步/单测/e2e/界面检查/CI 的耗时与稳定性验收指标。
- `test-execution-stability`：失败隔离与自动重试、flaky 判定与记录、`TIMING_FILES` 收缩依据、并行度自适应、分片资源隔离。
- `test-impact-selection`：改动到测试的选择粒度、必须全量的触发条件与理由、选择结果可复现、空选择必须报告。
- `test-environment-defaults`：默认英文环境、断言语言无关、e2e 只能在 WSL 跑、演示与正式后端字段一致、测试前清理继承环境。

### Modified Capabilities

（无。`openspec/specs/` 当前为空，本次 delta 全部是新增 capability，主 spec 由归档时创建。）

## Non-Goals

- 不处理 `openspec init` 生成的临时指令目录（`docs/` 下、被 `.gitignore` 排除、未入库、现已被清理）的可复现性问题：新环境需先在 `docs/` 下跑 `openspec init`（或 `openspec update`）。
- 不改产品功能、界面行为和执行引擎语义；只治理测试基础设施与验证方式。
- 不引入外部测试服务（远程缓存、云测试平台）或新的测试框架。
- 不为达标删测试：减少耗时只能来自分层、并发、选择精度和淘汰规则。
- 不处理与本 change 无关的测试失败（例如本次验证中 `server/task-children-count.test.ts` 在并发下的偶发失败只记录，不在本 change 修）。

## Acceptance

六项指标全部要可执行核对，详细证据回填 `acceptance.md`：

| 指标                  | 核对命令                                                        | 口径                                 |
| --------------------- | --------------------------------------------------------------- | ------------------------------------ |
| 本地六步整体 ≤ 4 分钟 | `node scripts/verify-local.mjs --runs 3`                        | 分组并行编排后的总墙钟，取三次中位数 |
| 单测 ≤ 3 分钟         | 同上输出里的单测行                                              | 单步墙钟                             |
| e2e ≤ 3 分钟          | 同上输出里的 e2e 行                                             | 单步墙钟                             |
| 界面检查 ≤ 2 分钟     | 同上输出里的界面检查行                                          | 单步墙钟                             |
| 连续 5 次全量无 flaky | `node scripts/flaky-check.mjs --runs 5`                         | 5/5 通过且 flaky 列表为空            |
| CI test job ≤ 10 分钟 | `node scripts/ci-timings.mjs --runs 20 --branch dev --job test` | 最近 20 次 P95                       |

## Impact

- **脚本入口**：`scripts/unit-tests.mjs`、`scripts/e2e.mjs`、`scripts/ui-check.mjs`、`scripts/changed-tests.mjs`；新增并发、预算、flaky、验收相关的纯函数模块与检查脚本。
- **CI**：`.github/workflows/ci.yml` 的 test / e2e / ui job 的并发、语言环境、耗时门禁。
- **测试代码**：`server/`、`shared/`、`web/src/` 下的测试文件按层改名或迁移；断言改为语言无关；新增测试的预算检查。
- **配置**：`package.json` 的 `test:*` 脚本与新增的验收脚本；`docs/agent-test-steps.md` 的默认步骤与命令。
- **文档**：新增 `docs/modules/testing/README.md`；更新 `docs/MODULE-MAP.md`、`docs/lessons/testing.md` 的相关小节。
- **依赖**：不新增 npm 依赖；并发与内存估算用 Node 内置 `os`。
