# Tasks

> 勾选含义：验证已通过，不是代码写完。每条任务的验证命令按顺序跑，结果回填 `acceptance.md`。
> 阶段 3 由父对话另行通知后执行；本文件先固定分组、验证方式和对应的 spec 需求。

## 1. 分层判定与用例预算（spec: test-layering-and-budget）

- [ ] 1.1 新增 scripts/lib/test-layers.mjs：`INTEGRATION_MARKERS` 与 `layerOf(file, sourceText)`，按运行时特征判纯函数 / 集成 / e2e；含单测覆盖服务、临时目录、git、子进程、纯逻辑五类样例。验证：`node scripts/unit-tests.mjs --files scripts/lib/test-layers.test.mjs`。
- [ ] 1.2 新增 `scripts/test-layers.mjs --report`，对现有测试文件产出 `test-layers.json`（层、命中特征、行数），人工抽查 10 个文件与判据一致。验证：`node scripts/test-layers.mjs --report`，抽查记录写进 evidence。
- [ ] 1.3 新增 scripts/lib/test-budget.mjs：按批 0 基线写入各层用例上限（向上取整到 10 的倍数，注释基线日期与生成命令），只降不升；含单测。验证：`node scripts/unit-tests.mjs --files scripts/lib/test-budget.test.mjs`。
- [ ] 1.4 新增 scripts/test-budget.mjs：`--check` 用静态扫描统计各层用例数（按 test-layers 分层，扫测试文件源码里的 `test(` / `it(`，不执行测试，秒级），`--tap <报告>` 用于 CI 复核；超限且提交说明缺 `测试预算:` 段时非零退出。验证：构造超限 fixture 跑一次期望失败，正常仓库跑一次期望通过，并用 `time` 确认静态检查是秒级。
- [ ] 1.5 接入：`npm run lint` 调静态 `test-budget --check`（不跑测试）；CI 的 `test` job 跑完单测后用 `--tap` 复核一次（同一次全量只统计一次，不重复跑测试）。验证：`npm run lint` 秒级通过；临时把上限改小后 `npm run lint` 非零退出，改回后通过。
- [ ] 1.6 文档：`docs/modules/testing/README.md` 写「分层边界与预算」小节，`docs/agent-test-steps.md` 的默认步骤补预算检查命令。验证：`npm run lint`（文档路径与格式检查）。

## 2. 归层迁移与覆盖不减少（spec: test-layering-and-budget / Migration preserves coverage）

- [ ] 2.1 新增 scripts/lib/test-inventory.mjs：解析 tap 输出的用例名集合，迁移前把基线写到 change 目录的 `evidence/test-inventory.baseline.json`；含单测。验证：`node scripts/unit-tests.mjs --files scripts/lib/test-inventory.test.mjs`，并核对基线文件里的用例数等于 2119。
- [ ] 2.2 批 1：把批 0 判为集成的文件改成 `*.integration.test.ts`，目录不变；同一提交把 `scripts/unit-tests.mjs` 的枚举改成「目录 + 判定函数」（pure 排除 `.integration.test.ts`，integration 只收它）、同步 `TIMING_FILES` 的显式路径和 `scripts/lib/changed-tests.mjs` 的测试文件识别正则；`covers.mjs`（界面分片 → 源码前缀）与按目录的高风险区不受改名影响，不动。验证：`npm run test:unit` 通过、`node scripts/test-inventory.mjs --diff` 的 removed 为空、`node scripts/test-budget.mjs --check` 通过。
- [ ] 2.3 批 2：拆分「一个文件覆盖多个互不相关源模块」的测试，每个文件顶部加 `// @covers <源文件>`；`scripts/rules-check.mjs` 增加「单测试文件 ≤ 300 行、@covers 指向同一模块」规则。验证：每拆一个文件跑 `node scripts/unit-tests.mjs --files <文件>` 与 `node scripts/changed-tests.mjs --files <源文件>`，命中集合与拆分前一致；`npm run lint` 通过。
- [ ] 2.4 批 3：按三类理由淘汰用例，逐条登记到 docs/openspec/changes/test-governance-budget-and-parallel-safety/migration.md（旧文件 / 用例名 / 新位置 / 理由类别 / 替代覆盖 / 验证命令），理由必须是固定枚举。验证：`node scripts/test-inventory.mjs --check-retire` 通过（理由在枚举内、removed 与登记一一对应、用 bugs 记录的「入口/症状/关键词」与待删用例名和 `@covers` 源文件做关键词交叉匹配并打印命中或已比对条数）；`node scripts/test-inventory.mjs --diff` 的 removed 只包含登记项；`node scripts/test-budget.mjs --check` 通过。反向验证：把一条理由改成「跑得慢」后期望检查失败；删一条命中 Bug 关键词的用例且不填替代时也期望失败。
- [ ] 2.5 文档：`migration.md` 填完整；`docs/modules/testing/README.md` 写「用例名基线怎么维护、淘汰怎么登记」。验证：`npm run lint`。

## 3. flaky 隔离、重试与串行清单收缩（spec: test-execution-stability）

- [ ] 3.1 新增 scripts/lib/retry.mjs：`MAX_ATTEMPTS = 3`、`classifyAttempts(results)`（全通过 / flaky / 真失败）、`failedUnitsFromTap(tap)`；含单测覆盖三种判定和重试上限。验证：`node scripts/unit-tests.mjs --files scripts/lib/retry.test.mjs`。
- [ ] 3.2 单测 runner 接入：失败后只重跑失败文件，总尝试 ≤ 3 次；写 `flaky-report.json`（单元、尝试次数、首次报错、最终状态、flaky 率）并打印。验证：注入一个必失败文件跑一次，确认尝试 3 次后真失败；注入一次失败后通过的文件，确认 flaky 报告并最终退出 0。
- [ ] 3.3 e2e 与界面检查 runner 接入：只重跑失败分片，上限 3 次尝试，分片结果并入同一份 flaky 报告。验证：`node scripts/e2e.mjs 07` 正常通过；用 `FAKE_*` 触发一次分片失败后确认重跑范围只有该分片。
- [ ] 3.4 `TIMING_FILES` 每条补证据注释（断言位置 + 最近失败记录）；先落地第 4 组并发上限，再逐条移出：移出前隔离连续 3 次全量通过、记录日期与机器配置，失败即加回并附输出；目标 ≤ 2 条。验证：每次移出跑 3 次 `npm run test:unit` + `npm run test:e2e` 并记录；`node scripts/unit-tests.mjs timing` 对剩余条目通过。
- [ ] 3.5 文档：`docs/modules/testing/README.md` 写「失败隔离、重试上限、串行清单依据」；`docs/lessons/testing.md` 补「重试语义」与「串行清单不是首选修复」两条。验证：`npm run lint`。

## 4. 并行度自适应与分片隔离（spec: test-execution-stability）

- [ ] 4.1 新增 scripts/lib/concurrency.mjs：`suggestConcurrency`（env 优先、CPU / 内存 / 单元上限取小、非法值走默认）与 `availableMemoryBytes`（cgroup v2 回退 `os.freemem`）；含单测覆盖 env 优先、内存限制、单元上限、0/负数/非数字。验证：`node scripts/unit-tests.mjs --files scripts/lib/concurrency.test.mjs`。
- [ ] 4.2 单测 runner 接入 `--test-concurrency=<value>`（timing 批固定 1），日志打印并发值、来源、CPU / 内存 / 单元估算。验证：`npm run test:unit` 通过，日志含「并发 N（来源：…）」；`AGENT_PANEL_UNIT_CONCURRENCY=1 npm run test:unit` 生效。
- [ ] 4.3 `scripts/e2e.mjs` 与 `scripts/ui-check.mjs` 接入 `suggestConcurrency`：`AGENT_PANEL_E2E_CONCURRENCY`、`AGENT_PANEL_UI_CONCURRENCY` 作为**上限之一**（不能抬高自动建议），界面默认上限为分片数，e2e 默认上限 4。验证：分别设 `=1` / `=2` 跑 `node scripts/e2e.mjs 07`、`npx vite build --mode demo && node scripts/ui-check.mjs 08-misc`，日志并发值与设置一致；再设 `AGENT_PANEL_UI_CONCURRENCY=99` 且内存只够 2 时，实际并发仍为 2 且日志写明环境变量作为上限未生效。
- [ ] 4.4 分片隔离补齐：分片设 `AGENT_PANEL_SHARD_ID`；e2e harness 校验服务回报的数据目录等于本次 `mkdtemp` 路径；界面检查每分片独立浏览器 `userDataDir`；端口冲突报错带分片名。验证：`node scripts/e2e.mjs 07` 与 `node scripts/ui-check.mjs 08-misc` 通过；人为占用某分片端口时失败信息含分片名。
- [ ] 4.5 文档：`docs/modules/testing/README.md` 写「并发计算、环境变量、分片隔离」；`docs/lessons/testing.md` 补「并发按内存取小」一条。验证：`npm run lint`。

## 5. 影响面细化与全量理由（spec: test-impact-selection）

- [ ] 5.1 新增 scripts/lib/test-covers.mjs：解析测试文件顶部与 `describe` 前的 `@covers` 注解，产出文件 → 源模块 / 用例组索引；含单测覆盖单行、多行、缺注解、非法路径。验证：`node scripts/unit-tests.mjs --files scripts/lib/test-covers.test.mjs`。
- [ ] 5.2 `scripts/changed-tests.mjs` 输出扩展为 `{ file, groups? }` 并打印每个命中的理由（直接映射 / 影响面闭包 / 同目录回退）；`unit-tests.mjs` 支持按组执行（`--test-name-pattern` 的 OR 组合），无法定位到组时退整文件并打印原因。验证：改一个只有单组的测试文件对应源文件，输出注明「用例级命中」；人为去掉分组命名后输出「分组不可定位」。
- [ ] 5.3 调整必须全量：高风险区收窄到契约文件清单（`shared/clis/*.json`、`shared/cli-spec.ts`、`shared/engine.ts`、`shared/schema.ts`、`shared/task.ts`、`server/task-store.ts`、`server/exec/runner.ts`、`server/exec/process.ts`），`FULL_COVERAGE_RATIO` 60% → 75%；`plan.full.tests` 改为 `{ required, triggers: [{ kind, files, threshold? }] }` 并逐条打印。验证：改 `shared/schema.ts` 输出触发类别与命中文件；改 `docs/lessons/testing.md` 不触发全量。
- [ ] 5.4 单测补：清缓存前后选择结果一致、空改动提示带基线、无对应测试交给父对话、依赖图不完整给出具体文件和 import 行。验证：`node scripts/unit-tests.mjs --files scripts/lib/changed-tests.test.mjs,scripts/changed-tests.test.mjs`。
- [ ] 5.5 文档：`docs/modules/testing/README.md` 写「选择规则与全量触发条件」；`docs/agent-test-steps.md` 的「改动 → 增量测试」小节更新；`docs/lessons/testing.md` 补「必须全量要给触发依据」。验证：`npm run lint`。

## 6. 环境默认化、验收命令与 CI 门禁（spec: test-environment-defaults / test-layering-and-budget）

- [ ] 6.1 默认英文环境：动手前检查 `scripts/unit-tests.mjs` 与 `package.json` 是否已有另一条父对话的 locale 实现，有则复用；没有则新增 scripts/lib/test-locale.mjs 的 `testLocaleEnv()` 并在单测 / e2e / 界面检查入口设置 `LANG` / `LC_ALL`；日志打印实际 locale 与来源。验证：`LANG=zh_CN.UTF-8 npm run test:unit` 日志显示英文生效；显式 `AGENT_PANEL_TEST_LOCALE=zh` 时日志显示覆盖来源。
- [ ] 6.2 新增 scripts/test-locale-check.mjs：扫描测试文件里的中文硬编码断言，支持 `// i18n-ok: <原因>` 例外；接进 `npm run lint`。验证：`npm run lint` 通过；临时加一条中文断言后 `npm run lint` 非零退出并指出文件行号。
- [ ] 6.3 CI 的 `test` job 显式设 `LANG` / `LC_ALL` 为 `C.UTF-8`；e2e / ui job 同样固定。验证：读 job 配置核对；CI 跑一轮确认英文环境通过。
- [ ] 6.4 新增 scripts/verify-local.mjs：按**分组并行**编排跑六步（测试组：test:unit / e2e / 界面检查同时启动；静态组：typecheck / lint / build 同时启动；Windows 上 e2e 自动包 WSL，界面检查先 `vite build --mode demo`），并行前先算全局预算（可用内存 70% 按 120:600:500 权重分给三个入口）并通过 `AGENT_PANEL_*_CONCURRENCY` 透传，子入口不再重复按内存自算；输出每步耗时与并行后的总墙钟（不是分项相加）；`--runs 3` 取总墙钟中位数；任一分项或总墙钟超预算非零退出并打印超标步骤命令。验证：`node scripts/verify-local.mjs --runs 1` 输出六步耗时与总墙钟；人为把单测预算改成 1 秒时非零退出；确认三个入口日志的并发值之和不超过全局预算，且判定用的是并行墙钟而不是分项求和。
- [ ] 6.5 新增 `scripts/flaky-check.mjs --runs 5`：连续 5 次调用验收入口，收集失败集合与 flaky 报告；任一次失败或 flaky 非空即非零退出。验证：`node scripts/flaky-check.mjs --runs 5` 输出 5 次结果与 flaky 列表。
- [ ] 6.6 新增 `scripts/ci-timings.mjs --runs 20 --branch dev --job test`：用 `gh run list` + `gh api .../jobs` 取 `test` job 时长，输出每次完整 sha、P50、P95 与最慢步骤，P95 超 10 分钟非零退出。验证：`node scripts/ci-timings.mjs --runs 20 --branch dev --job test` 输出统计；临时把上限改成 1 分钟时非零退出。
- [ ] 6.7 文档与模块登记：新建 `docs/modules/testing/README.md`（入口脚本、分片结构、各层边界、怎么跑、怎么加用例、预算与并发、失败处理），在 `docs/MODULE-MAP.md` 加 `testing` 行并在「不容易发现位置的改动」补一行；`docs/agent-test-steps.md` 的常用命令补验收入口。验证：`npm run lint`（`scripts/lib/doc-modules.mjs` 校验模块表与 `docs/modules/*` 双向一致）。
- [ ] 6.8 WSL 限制：在 Windows 上直接运行 `npm run test:e2e` 时先检查环境，非 WSL 就输出「e2e 需要 WSL（Ubuntu-24.04），当前环境不满足」并非零退出；`npm run test:e2e:wsl` 正常执行（走 WSL 默认发行版，要求默认发行版是 Ubuntu-24.04）。验证：PowerShell 里跑 `npm run test:e2e` 期望非零退出并看到提示；`npm run test:e2e:wsl` 通过；需要显式指定发行版时命令必须带 `cd <工作区>`（`bash -lc` 会落到 `$HOME`）。
- [ ] 6.9 演示 / 正式后端字段一致：界面检查读取后端字段前先核对该字段在两份后端都存在；后端新增或重命名字段时同一次提交补 `web/src/lib/demo-*.ts`；缺字段时检查直接失败并指出字段名。验证：`npx vite build --mode demo && node scripts/ui-check.mjs 08-misc` 通过；临时从演示后端删一个界面检查读取的字段，确认检查失败并输出字段名。
- [ ] 6.10 继承环境清理：单测 / e2e / 界面检查入口启动前清掉 `AGENT_PANEL_*`、`GIT_CONFIG_*` 等干扰变量并打印被清理的变量名；分片数据目录只取本次 `mkdtemp`。验证：带 `AGENT_PANEL_TRAY=1`、`GIT_CONFIG_COUNT=1` 跑三个入口，核对日志与分片数据目录。
- [ ] 6.11 CI 读 flaky 报告判红：CI 的 `test` job 在单测后加一步 `node scripts/flaky-check-report.mjs`，`flaky-report.json` 存在且 `units` 非空则非零退出（不只看退出码）；每次运行开始先删旧报告（没有 flaky 就写 `{ units: [] }`）。验证：注入一个首次失败后重跑通过的文件，本地跑该步骤期望非零退出并列出 flaky 用例；先留一份非空报告再跑一次干净单测，期望该步骤退出 0；正常通过时也退出 0。

## 需求覆盖核对（阶段 2 出口门禁）

| spec 需求 | 覆盖它的 task |
| --- | --- |
| test-layering-and-budget / Test layer classification | 1.1、1.2 |
| test-layering-and-budget / Per-layer test budget | 1.3、1.4、1.5 |
| test-layering-and-budget / Test retirement criteria | 2.4 |
| test-layering-and-budget / Verification time budget | 6.4 |
| test-layering-and-budget / Flakiness-free acceptance | 6.5 |
| test-layering-and-budget / CI test job budget | 6.6 |
| test-layering-and-budget / Migration preserves coverage | 2.1、2.2、2.4 |
| test-execution-stability / Bounded failure retry | 3.1、3.2、3.3、6.11 |
| test-execution-stability / Timing serial list justification | 3.4 |
| test-execution-stability / Adaptive parallelism | 4.1、4.2、4.3 |
| test-execution-stability / Shard resource isolation | 4.4 |
| test-execution-stability / Environment inheritance is cleared | 4.4、6.10 |
| test-impact-selection / Selection reports hit basis | 5.2 |
| test-impact-selection / Case-level selection granularity | 5.2 |
| test-impact-selection / Justified full-run triggers | 5.3 |
| test-impact-selection / Reproducible selection | 5.4 |
| test-impact-selection / Empty selection is reported | 5.4 |
| test-environment-defaults / Default English locale | 6.1、6.3 |
| test-environment-defaults / Language-independent assertions | 6.2 |
| test-environment-defaults / WSL-only e2e | 6.8 |
| test-environment-defaults / Demo-backend parity | 6.9 |
| test-environment-defaults / Clean inherited environment | 6.10 |

## Workflow follow-up

- 阶段 4：跑 `flaky-check --runs 5` 与 `ci-timings`，把证据回填 `acceptance.md`，再按技能执行归档。
- 归档后按 `project-vcs` 收尾，变更范围包含归档产生的目录移动与主 specs 变更。
