# ADR 0024：测试默认只输出失败和汇总，失败只重跑失败的部分，用例数量有预算

状态：已接受 · 2026-10-28（第 4 条「用例预算棘轮」被 [ADR 0031](./0031-test-count-report-not-cap.md) 替代：总数不设上限，只拦本次净新增）

## 背景

用户 2026-10-28 提出：测试在不断膨胀，这部分成本剧增，失败重测又是很大的问题，要约束和设计测试框架、缩短测试时间、提升开发效率。
这个仓库的测试大多是 Agent（子对话、测试验收）在跑，「成本」除了机器时间，还有 Agent 读输出的 token 和失败后整套重跑的等待。

已有的 change `docs/openspec/changes/test-governance-budget-and-parallel-safety/` 规划了 37 项任务（分层改名、自适应并发、用例级选择、验收入口……），一项都没落地。这次先做收益最大、改动面最小的三件。

## 事实核对

| 位置                                      | 改动前                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `scripts/unit-tests.mjs`                  | `stdio: 'inherit'` 原样打 TAP：一次全量约 1.3 万行、50 万字节（2026-10-28 实测）；失败不重跑，只能整套再来            |
| `scripts/e2e.mjs`、`scripts/ui-check.mjs` | 失败时打该分片全部输出；没有重跑，再跑要手动按前缀筛                                                                  |
| 测试数量                                  | 单测约 2200 条、端到端 122 步、界面检查 403 次检查，没有任何上限                                                      |
| `server/exec/orphans.ts`                  | 杀完进程固定等 3.5 秒再确认：`orphans.test.ts` 11 条用例 23.6 秒，是最慢的单测文件                                    |
| 继承环境                                  | 单测、端到端直接继承开发机环境：云端容器的 `ANTHROPIC_BASE_URL` 让 `accounts` 分片稳定失败                            |
| `server/exec/worktree.ts`                 | 合并撞上 `index.lock` 时只认 `index.lock` 字样；git 2.43 先跑 `git stash create`，报的是 `stash failed`，被误判成冲突 |

## 决策

1. **默认只输出失败和汇总**：单测用自定义 reporter（`scripts/lib/test-reporter.mjs`）出结构化事件，终端只打每批结论、失败详情（每条 20 行）、抖动、慢用例（> 2s）、最慢的 5 个文件；完整 TAP 写进 `logs/tests/`，`--verbose` 才打到终端。
2. **失败只重跑失败的部分**：单测失败的文件串行重跑，总共最多 3 次；端到端、界面检查失败的分片串行再跑 1 次（分片贵）。重跑通过的记成「抖动」，醒目报出、写进 `logs/tests/*-last.json`，退出码按最后一次算；`--no-retry` 关掉。
3. **改完只复测失败的**：还失败的记进 `logs/tests/{unit,e2e,ui}-last.json`，`npm run test:failed`、`--failed` 只跑它们。
4. **用例预算棘轮**：分层判据和各层上限在 `scripts/lib/test-layers.mjs` / `scripts/lib/test-budget.mjs` 一处定义，`scripts/test-budget.mjs --check` 静态数（行首的 `test(` / `it(` / `step(`），`npm run lint` 超了失败；CI 单测跑完再用 `--tap` 复核。上限只降不升，往上抬会被检查拦下；抬高要在提交说明写「测试预算：」。
5. **测试进程不继承接口变量**：`scripts/lib/test-env.mjs` 去掉 `ANTHROPIC_*`、`OPENAI_*`、`CLAUDE_CODE_*` 等。
6. 顺带修掉两处拖慢 / 弄红测试的产品问题：`orphans.ts` 改成轮询等进程退出（上限仍 3.5 秒，`orphans.test.ts` 23.6s → 10.2s）；`worktree.ts` 认出 `stash failed` + 锁文件在场也是锁冲突（git 2.43 下合并不再误报冲突）。

没选的方案：

- **重跑通过算失败**：会把一次抖动变成整轮红，又逼着整套重跑；改成「通过但醒目报出、记录在案」，修抖动是另一件事。
- **按用例时长设硬预算**：时长随机器变，在 CI、云端容器、Windows 上都会误报；只列慢用例和最慢的文件，提示改写法。
- **先做分层改名（`*.integration.test.ts`）**：要改 72 个文件名并同步多处清单，收益是「看得清」，不直接省时间或 token；留在原 change 里。
- **按行数限制单个测试文件**：现有文件差异很大，一刀切会逼着拆文件而不是减用例；预算按区数用例更直接。

## 操作清单 / 契约

| 命令                                                                 | 作用                                   |
| -------------------------------------------------------------------- | -------------------------------------- |
| `npm run test:unit`                                                  | 全量单测，精简输出，失败文件自动重跑   |
| `npm run test:failed`                                                | 只跑上次还失败的单测文件               |
| `npm run test:unit -- --verbose / --no-retry`                        | 完整输出 / 不重跑                      |
| `npm run test:e2e -- --failed`、`node scripts/ui-check.mjs --failed` | 只跑上次失败的分片                     |
| `node scripts/test-budget.mjs --check`、`--tap <报告>`               | 静态检查各层预算 / 用已跑出的 tap 复核 |

## 与现有实现的关系

- 新增：`scripts/lib/test-reporter.mjs`、`scripts/lib/test-results.mjs`、`scripts/lib/shard-retry.mjs`、`scripts/lib/test-env.mjs`、`scripts/lib/test-files.mjs`、`scripts/lib/test-budget.mjs`、`scripts/lib/test-layers.mjs`、`scripts/test-budget.mjs`；单测 `scripts/lib/test-results.test.mjs`、`scripts/lib/test-env.test.mjs`。
- 改动：`scripts/unit-tests.mjs`、`scripts/e2e.mjs`、`scripts/ui-check.mjs`、`scripts/e2e/harness.mjs`、`scripts/e2e/spawn-server.mjs`、`package.json`（`lint` 加预算检查，新增 `test:failed`）。
- `TIMING_FILES`、`--files`、`changed-tests` 的口径不变（ADR 0020）；`test:affected` 照常把命中的文件交给 `--files`，同样享受精简输出和失败重跑。
- 给 Agent 的规则：`skills/project/project-testing/SKILL.md` 补「失败只复测失败的」「只看失败详情和汇总」。

## 运行时

结果文件和日志在 `logs/tests/`（`logs/` 已在 `.gitignore`），每次运行覆盖。解析不到失败用例、退出码却非零时（加载失败、被杀），按整批失败处理并打 stderr 末尾 30 行，不当成通过。

## 分期

一次做完。原 change 里的分层改名、自适应并发、用例级选择、验收入口、CI 判红留在原 change，等这三件跑一段时间看数据再定。

## 风险与代价

- 精简输出可能藏住失败以外的有用信息（例如用例里打印的诊断）：完整 TAP 在日志里，失败时打出日志路径。
- 预算是静态数的，和实际用例数有几条出入：要的是「涨了看得见」，不是精确计数。
- 自动重跑会掩盖抖动：所以抖动单独醒目报出、写进结果文件，`--no-retry` 可以看第一次的真实结果。

## 开放问题

- CI 是否在出现抖动时判红：倾向先只报告，攒几周数据再定。定下来之前 CI 照常按退出码。
