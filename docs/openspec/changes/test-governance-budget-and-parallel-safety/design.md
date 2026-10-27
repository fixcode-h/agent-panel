# Design

> 规划约定：本文里**不加反引号**的路径是阶段 3 才创建的文件（规则检查只校验反引号内的路径必须已存在）；加反引号的是现有文件。

## Context

见 `proposal.md` 的 Why。这里只列影响方案选择的现状事实（2026-10-27 核对）：

- **规模**：单测 238 文件 / 2119 用例（server 136、shared 54、web/src 48 文件）；e2e 13 个分片（编号 01–08、10–14，无 09）；界面检查 12 个分片。父对话实测本地六步 6m5s，单测 2m53s–6m44s，e2e 1m13s–6m，界面检查 1m10s–5m35s。
- **分层现状**：`server/` 下 72 个测试文件包含 `mkdtemp` / `execFileSync` / `spawn` / `listen` / `Hono` 一类集成特征；`shared/`、`web/src/` 目前没有这类特征。2119 个用例没有区分层。
- **runner 现状**：
  - `scripts/unit-tests.mjs`：`TIMING_FILES` 5 个文件（`server/exec/worktree.test.ts`、`server/exec/pi-rpc.test.ts`、`server/task-store.test.ts`、`server/exec/process.test.ts`、`server/background.test.ts`）加 `--test-concurrency=1` 串行；其余交给 `node --test` 默认并发（等于 CPU 核数）。
  - `scripts/e2e.mjs`：固定 `DEFAULT_CONCURRENCY = 4`，`AGENT_PANEL_E2E_CONCURRENCY` 覆盖；每个分片 `mkdtempSync` 独立数据目录，服务 `listen(0)` 后从 stdout 回报 `AGENT_PANEL_PORT`，`spawn-server.mjs` 校验分片唯一 `instance`。
  - `scripts/ui-check.mjs`：默认 `min(分片数, availableParallelism())`，`AGENT_PANEL_UI_CONCURRENCY` 覆盖；每个分片独立静态服务、浏览器、演示数据。
- **选择现状**：`scripts/changed-tests.mjs` + `scripts/lib/changed-tests.mjs` 按 import 反向闭包做文件级选择；高风险区是目录级（`server/exec/**`、`shared/clis/**`、`shared/builtin/**`、`shared/engine.ts`、`shared/schema.ts`）；`FULL_COVERAGE_RATIO = 60%`；删除/改名、依赖图不完整都判必须全量。
- **CI**：`test` job（typecheck / lint / test:unit / build，timeout 30 分钟）、`e2e` job（20 分钟）、`ui` job（15 分钟），三个 job 各自独立 VM、并行。
- **并行进行中的另一条父对话**：让 `npm run test:unit` 默认英文环境（改 runner 环境变量并修受影响断言）。本设计引用它，不重复实现。

## Goals / Non-Goals

**Goals**（设计层，不复述 proposal 范围）

- 分层判据客观可执行，改名迁移不依赖人工判断。
- 预算、并发、flaky、验收四件事各只有一个计算入口，runner、CI、文档引用同一份常量。
- 迁移可分三批独立验证、独立回滚，且能证明「没有少跑用例」。
- 选择精度提高后仍能解释每一次「必须全量」。

**Non-Goals**

- 不引入新的测试框架、远程缓存或云测试平台。
- 不改产品代码行为；只动测试、测试基础设施、CI 与文档。
- 不在本 change 处理 `openspec init` 生成的临时指令目录（`docs/` 下、被 `.gitignore` 排除、未入库、已被清理）的可复现性（见 proposal 非目标）。
- 不追求「单测零 flaky」：目标是可归因、可复现、有预算，flaky 用例必须被记录并进入修复队列。

## Decisions

### D1 分层用「文件后缀 + 运行时特征」判定，不按目录

- **判定**：纯函数层 = `*.test.ts` 且不含集成特征；集成层 = `*.integration.test.ts`（文件内可继续用 `*.test.ts` 的写法）；e2e 层 = `scripts/e2e/NN-*.mjs`。集成特征清单固定为：启动 HTTP 服务 / 监听端口、`mkdtemp` / 真实文件读写、执行 git、`spawn` / `execFile` 子进程、连接真实 CLI。
- **实现**：scripts/lib/test-layers.mjs 导出 `layerOf(file, sourceText)` 与 `INTEGRATION_MARKERS`；`scripts/unit-tests.mjs` 的枚举从现在的「目录 + 后缀正则」（四组：server / shared / web/src / scripts）改成「目录 + 判定函数」：pure = `.test.ts` 且非 `.integration.test.ts`，integration = `.integration.test.ts`，scripts = `.test.mjs`（e2e 不在单测内）；新增 `--layer <pure|integration>` 过滤参数。集成层单独用更低并发上限（见 D6）。
- **为什么不用目录**：现有测试与源文件同目录，按目录分层会与模块目录冲突；改名只动文件名，`changed-tests` 的 import 图、`covers`、`TIMING_FILES` 的引用可以在同一提交里一起更新。
- **备选**：新建 `tests/` 总目录（import 路径全改、影响面映射要重写，代价远大于收益）；用 `node:test` 的 `describe` 嵌套标记（无法阻止跨层混写）。

### D2 预算常量一处定义，超限阻断

- **常量**：scripts/lib/test-budget.mjs 的 `TEST_BUDGET = { pure, integration, e2eShards, e2eSteps }`。数字来源是迁移批 1 的分层基线（向上取整到 10 的倍数），每个数字旁写基线日期和生成命令；首次写入后只降不升。
- **统计分两级**：本地 `npm run lint` 用**静态计数**——按 D1 的分层扫测试文件源码里的 `test(` / `it(` 调用，不执行测试（秒级）；CI 在跑完单测后额外用 tap 结果（`# tests N`）复核一次，e2e 从 `e2e-timings.json` 的 `steps.length` 累加。同一次全量只统计一次，lint 再跑一遍全量测试是不允许的。
- **强制替换**：超预算时检查脚本读取 `git log -1 --format=%B`，要求提交说明里有 `测试预算:` 段（写清覆盖能力、删除用例与被替代关系）；缺失则非零退出。
- **接入**：`npm run lint` 调 `scripts/test-budget.mjs --check`（静态计数，不跑测试）；CI 的 `test` job 跑完单测后用 `--tap <报告>` 复核一次。
- **备选（未采用）**：只输出警告（用户明确要硬预算）；把数字写进文档（文档与脚本会漂移）。

### D3 迁移三批，每批一个提交、独立验证

| 批次 | 内容 | 验证 | 回滚 |
| --- | --- | --- | --- |
| 批 0（只读） | `node scripts/test-layers.mjs --report` 产出 `test-layers.json`：每个文件的层、命中的集成特征、行数 | 人工抽查 10 个文件，确认判据 | 无改动 |
| 批 1（改名） | 按批 0 清单把集成特征文件改成 `*.integration.test.ts`，目录不变；同一提交更新枚举函数（目录 + 判定函数）、`TIMING_FILES` 的显式路径、`scripts/lib/changed-tests.mjs` 的测试文件识别正则。`covers.mjs` 登记的是界面分片 → 源码前缀，与单测改名无关，不动；依赖目录的高风险区也不受改名影响 | `npm run test:unit` 全量 + 用例名集合与基线 diff（期望为空）+ `node scripts/test-budget.mjs` | 单提交 revert |
| 批 2（拆分） | 只对「一个文件覆盖多个互不相关源模块」的测试拆分，拆完每个文件顶部加 `// @covers <源文件>` | 每拆一个文件跑该文件 + `node scripts/changed-tests.mjs --files <源文件>`，确认命中集合不变 | 单文件提交 revert |
| 批 3（淘汰） | 按三类淘汰理由删除/合并，逐条登记（理由用固定枚举） | `node scripts/test-inventory.mjs --check-retire`（理由枚举、removed 与登记对应、用户 Bug 回归未删）+ `node scripts/test-budget.mjs`（数量下降） | 单条提交 revert |

- **不破坏覆盖的检查**：scripts/lib/test-inventory.mjs 解析 tap 的用例名（`ok N - <name>`），迁移前把基线写到 docs/openspec/changes/test-governance-budget-and-parallel-safety/evidence/test-inventory.baseline.json；每批跑完输出 `added / removed / unchanged`，`removed` 必须与 `migration.md` 的登记逐条对应。
- **淘汰的机器校验**（`test-inventory --check-retire`）：读 `migration.md` 的表格，理由不在固定枚举（`能力已删除` / `已完全覆盖` / `长期 flaky`）内即失败；`removed` 与登记不能一一对应即失败。用户 Bug 回归用**关键词交叉匹配**判定（Bug 记录只有元数据头，不含测试文件路径），规则是**精确匹配**：源文件 basename 精确出现在 Bug 记录的「入口 / 症状 / 关键词」里，或关键词长度 ≥3 且作为整词命中待删用例名；长度 <3 的关键词不参与匹配。命中即要求登记里写清等价回归用例并打印「命中 bug-id + 依据的关键词」；未命中打印「已比对 N 条、命中 0 条」。只靠人工评审不算通过。
- **对应关系记录**：docs/openspec/changes/test-governance-budget-and-parallel-safety/migration.md，表格列：旧文件 / 用例名 / 新位置 / 批次 / 理由类别（固定枚举：改名 / 拆分 / 能力已删除 / 已完全覆盖 / 长期 flaky）/ 替代覆盖 / 验证命令。
- **谁跑**：阶段 3 由父对话派执行者按批执行；本阶段（0/2）不执行任何迁移。每批完成即提交并验证，不带半状态进入下一批。

### D4 flaky 隔离与自动重试

- **纯函数**：scripts/lib/retry.mjs 的 `MAX_ATTEMPTS = 3`、`classifyAttempts(results)`（全部通过 / flaky / 真失败）、`failedUnitsFromTap(tap)`（从 `not ok` 行取文件与用例名）。
- **runner 接入**：
  - 单测：失败后按「失败文件」重跑（`--files` 只传失败文件），不在批次粒度重跑；总尝试 3 次。
  - e2e：失败后只重跑失败分片；界面检查同理。
  - 重试用内部参数 `--retry-failed`，用户不可用「重新跑全量」触发。
- **结果**：写 `flaky-report.json`（`{ units: [{ name, attempts, firstError, finalStatus }] }`）并打印。每次运行开始先删除旧报告（本次没有 flaky 就写 `{ units: [] }`），否则上一次的非空报告会让下一次干净的 CI 运行被判红。退出码口径与 spec 一致，分三段：**0 = 本次没有失败（含重跑后通过）；1 = 真失败（3 次尝试都失败）；flaky（重跑后通过）退出 0，但必须写 `flaky-report.json`，由 CI 的独立步骤读它判红**。这样日常开发不被偶发失败卡死，CI 又不会把 flaky 当成功放过去。
- **统计口径**：flaky 率 = flaky 用例数 / 本次运行用例总数；写进 `flaky-report.json` 供趋势对比。
- **备选**：重试通过就完全当成功（会掩盖问题，用户要求「连续 5 次无 flaky」）；失败直接判真失败（会把机器负载当成代码问题）。

### D5 `TIMING_FILES` 收缩依据与替代机制

- **保留标准**：文件里存在真实时钟断言（`Date.now` / `setTimeout` / 落盘窗口 / 超时）或依赖并发窗口；每个条目在清单里带一行注释：断言位置 + 最近一次失败记录（链接到 `docs/lessons/testing.md` 对应小节或 issue）。
- **收缩流程**：先落地 D6（并发上限），再逐条移出；每条移出前在**目标并发配置下连续 3 次全量运行**通过（D6 的上限已生效，不是只跑该文件；记录并发值、机器配置和日期）；移出后任一全量失败即加回并附输出。
- **目标**：迁移完成后清单 ≤ 2 条（预计保留 `server/task-store.test.ts`、`server/exec/process.test.ts`，等可控时钟改造）。
- **替代机制**：文件级隔离重跑（D4）+ 内存/CPU 自适并发（D6）+ 用例内可控时钟（长期，不在本 change）；清单只兜底真正无法改造的时钟断言。
- **复核**：每次全量 flaky 或每季度复核一次，复核结论写进 `docs/modules/testing/README.md` 的「串行清单」小节。

### D6 并行度自适应：一个纯函数，三处接入

- **纯函数**：scripts/lib/concurrency.mjs
  ```js
  suggestConcurrency({ units, cpus, freeMemBytes, memPerUnitBytes, explicit, min = 1, max })
  // => { value, source: 'env' | 'cpu' | 'memory' | 'units' }
  ```
  规则：`auto = min(cpus, floor(freeMemBytes / memPerUnitBytes), units, max)`；显式环境变量是**上限**不是覆盖：`value = min(auto, explicit ?? auto)`，设得比自动建议大时仍取自动建议，设得更小时取它；`source` 取生效的最小项（`cpu` / `memory` / `env` / `units`），`value` 最小 1。旧的「用 env 强制全并发」语义取消——那会绕开内存限制，正是这次要消除的假失败来源。
- **内存估算常量**（集中在这个文件，注释写实测来源）：单测每 worker 约 120MB（tsx + node），e2e 每分片约 600MB（服务 + 多个假 CLI 进程），界面检查每分片约 500MB（Chromium + 静态服务）。估算是上限，不是承诺。
- **可用内存**：`availableMemoryBytes()` 优先读 cgroup v2（`/sys/fs/cgroup/memory.max`、`memory.current`，CI 容器），回退 `os.freemem()`；Windows 上直接用 `os.freemem()`，并保留安全系数 0.8。
- **接入**：
  - 单测：rest 批传 `--test-concurrency=<value>`；timing 批固定 1；`AGENT_PANEL_UNIT_CONCURRENCY` 覆盖，默认 `max = cpus`。
  - e2e：`scripts/e2e.mjs` 用 `suggestConcurrency`，`AGENT_PANEL_E2E_CONCURRENCY` 优先，默认 `max = 4`（保留现有兜底，避免行为突变）。
  - 界面检查：`AGENT_PANEL_UI_CONCURRENCY` 优先（**继续有效**），默认 `max = 分片数`；替换现有 `availableParallelism()` 直取。
- **可观测**：每个入口打印 `并发 N（来源：内存限制；CPU 32 / 可用内存 4.2GB / 单元 500MB / 分片 12）`，写进 `ui-timings.json` / `e2e-timings.json` 的 `concurrency` 字段。
- **预算透传**：`verify-local` 并行跑测试组时额外设置 `AGENT_PANEL_CONCURRENCY_BUDGET=<上限>` 和 `AGENT_PANEL_CONCURRENCY_BUDGET_FROM=verify-local`（三个 `AGENT_PANEL_*_CONCURRENCY` 仍表示用户上限，语义不变）；子入口只有看到 `..._BUDGET_FROM=verify-local` 时才以预算值为上限、跳过按内存自算，日志注明「预算由 verify-local 分配」。用户手动设 `AGENT_PANEL_UI_CONCURRENCY=12` 单跑时没有这个标记，仍按上面的规则被内存压到 auto。
- **兼容**：现有 `shard-limit.mjs` 的「非数字/0/负数走默认」语义保留，`suggestConcurrency` 内部复用同一个校验。
- **备选**：只按 CPU（现状，内存不足仍超时）；固定小并发（高配机器浪费，低配机器仍卡）。

### D7 分片资源隔离补齐

- 现状已经做到「每分片独立 `mkdtemp` 数据目录 + `listen(0)` + instance 校验」，本设计补三处：
  1. 分片环境变量 `AGENT_PANEL_SHARD_ID=<分片名>`，日志与失败信息带上它，冲突时能定位到片。
  2. e2e harness 在启动服务后校验服务回报的 `AGENT_PANEL_DATA` 与本次 `mkdtemp` 路径一致；不一致直接失败（防继承）。
  3. 界面检查每个分片使用独立浏览器 `userDataDir`（`mkdtemp`），不共享 localStorage / 缓存。
- **端口**：继续 `listen(0)` + 服务回报，不引入固定端口段；`spawn-server.mjs` 的冲突报错补分片名。
- **演示与正式后端字段一致**：界面检查读取后端字段前，先在两份实现里核对同名字段；后端新增 / 重命名字段时同一次提交补 `web/src/lib/demo-*.ts`，缺字段直接失败并指出字段名（对应 spec `test-environment-defaults` 的 Demo-backend parity）。
- **备选**：给分片预分配端口段（并行时仍可能被其它进程占用，反而要多一层重试）。

### D8 影响面细化到用例级

- **8.1 测试文件拆分**：`scripts/rules-check.mjs` 新增规则——单测试文件 ≤ 300 行，顶部 `@covers` 只能指向一个源模块（同一行为域的多个文件可以写多行，但必须在同一模块目录）；旧文件分批拆，不做全仓格式化。
- **8.2 `@covers` 注解**：测试文件顶部 `// @covers shared/task.ts`；`describe` 前可写 `// @covers shared/task.ts#childIcon`。scripts/lib/test-covers.mjs 解析成索引（纯文本，不执行测试）。选择结果从 `{ file }` 扩展为 `{ file, groups?: string[] }`，组级命中用 `node --test --test-name-pattern` 的 OR 组合执行；无法定位到组时退回整文件并打印原因。
- **8.3 必须全量的阈值与范围**：
  - 高风险区从目录级收窄到文件级契约清单：`shared/clis/*.json`、`shared/cli-spec.ts`、`shared/engine.ts`、`shared/schema.ts`、`shared/task.ts`、`server/task-store.ts`、`server/exec/runner.ts`、`server/exec/process.ts`；`server/exec/` 其余文件不再一刀切。
  - `FULL_COVERAGE_RATIO` 从 60% 提到 75%；`FULL_COVERAGE_MIN_TESTS` / `FULL_COVERAGE_MIN_SHARDS` 保持并写进报告。
  - 删除/改名、依赖图不完整仍是必须全量，但报告要给出具体文件和那行 import。
- **8.4 理由结构化**：`plan.full.tests = { required, triggers: [{ kind, files, threshold? }] }`；终端按触发类别逐条打印，JSON 输出供验收脚本核对。
- **8.5 可复现**：选择输出不含时间戳；缓存格式版本升级（`CACHE_VERSION` +1）；`scripts/lib/changed-tests.test.mjs` 增加「清缓存前后一致」用例。
- **8.6 空选择**：保持现有行为并补断言——空清单提示带基线重跑；无对应测试时明确交给父对话。

### D9 默认英文环境：与另一条父对话的分工

- **依赖关系**：另一条父对话负责「让 `npm run test:unit` 默认英文环境并修受影响断言」。本 change **不重复实现**同一件事。
- **实现顺序（谁先合都安全）**：阶段 3 动手前先读 `scripts/unit-tests.mjs` 与 `package.json`；已有 locale 设置则直接复用，没有才添加 scripts/lib/test-locale.mjs 的 `testLocaleEnv()`。两边都改到同一处时，以先合入的实现为准，后合入的只补检查与验收，不再改 runner。
- **本 change 独有部分**：
  - scripts/test-locale-check.mjs：扫描测试文件里的中文硬编码断言（`assert.*(/中文/)`、`assert.equal(…, '中文')`），允许行尾 `// i18n-ok: <原因>` 例外；接入 `npm run lint`。
  - CI 的 `test` job 显式设 `LANG` / `LC_ALL` 为 `C.UTF-8`，不依赖 runner 默认。
  - `acceptance.md` 记录：对方未合入时，本 change 的环境默认化验收项标「依赖中」；对方合入后跑 `test-locale-check` 与英文环境全量作为证据。
- **不冲突的证明**：两处改用同一个入口函数；若对方已引入自己的常量，命名不同也只在 adapter 层转换，不出现两套默认值。

### D10 验收命令与 CI 统计

- scripts/verify-local.mjs：按**分组并行**编排跑六步——测试组（test:unit / e2e / 界面检查）同时启动，静态组（typecheck / lint / build）同时启动；Windows 上 e2e 用 `npm run test:e2e:wsl`（走 WSL 默认发行版，默认发行版必须是 Ubuntu-24.04，见 testing 模块文档），界面检查先 `vite build --mode demo`。并行前先算**全局预算**：读一次可用内存，取 70% 作为测试组预算，按单测 120MB/worker、e2e 600MB/分片、界面 500MB/分片 的权重分给三个入口，得到各自上限后经 `AGENT_PANEL_CONCURRENCY_BUDGET` + `..._FROM=verify-local` 传给子入口（见 D6 的预算透传）。这样三个入口的并发值之和不超过全局预算，不会各自以为自己能独占整台机器。每步计时写 `verify-local.json`，输出每步耗时与并行后的总墙钟（不是分项相加）；`--runs 3` 连跑三次取总墙钟中位数；任一分项或总墙钟超预算非零退出并打印该步命令与耗时。
- `scripts/flaky-check.mjs --runs 5`：连续 5 次调用 `verify-local`，收集失败集合与 `flaky-report.json`；任一次失败或 flaky 列表非空即非零退出。
- `scripts/ci-timings.mjs --runs 20 --branch dev --job test`：用 `gh run list --json databaseId,headSha,conclusion,createdAt` + `gh api repos/{owner}/{repo}/actions/runs/{id}/jobs` 取 `test` job 时长，算 P50 / P95，超 10 分钟非零退出；输出每次的完整 sha 与时长。
- **文档落点**：命令与预算写在 `docs/modules/testing/README.md`（新建）与 `docs/agent-test-steps.md` 的「怎么跑」；`docs/lessons/testing.md` 补「重试与 flaky 判定」「预算硬上限」两条规则。

## Risks / Trade-offs

- [改名迁移打断 `TIMING_FILES` / `covers` / `changed-tests` 的路径引用] → 批 1 一次性更新所有引用，脚本对不存在的路径直接失败（现有行为），不留半状态；单提交可回滚。
- [用例级选择依赖 `describe` 命名，命名漂移会错选] → 无法定位时退整文件并打印原因；`@covers` 作为第二信号；验收时抽样对比「增量选中集合 ⊆ 全量通过集合」。
- [默认英文会让现有写死中文的断言失败] → 先跑 `test-locale-check` 修断言，再切默认；顺序写进 D9。
- [预算硬上限挡住合理的新功能测试] → 允许在同一提交里提高上限，但必须由评审批准并在提交说明写理由；默认只降不升，替换优先合并而不是删。
- [内存估算不准导致 OOM 或假失败] → 估算是上限；运行失败时降一半并发重试一次并记录实际用量；用户可显式设置环境变量。
- [CI P95 受 runner 波动影响] → 同时输出 P50 与逐次数据；只有 P95 超限才失败，便于人工判断是趋势还是抖动。
- [本地六步串行跑比 CI 三 job 并行慢] → `verify-local` 是验收入口，不替代 CI；CI 仍三个 job 并行。
- [flaky 重试通过仍退出 0] → 验收脚本 `flaky-check` 把它判为不通过；日常开发不卡，发布门禁严格。

## Migration Plan

1. **批 0**：只读产出分层基线（`test-layers.json`），不提交代码。
2. **批 1**：改名 + 引用更新，一个提交；验证用例名集合 diff 为空。
3. **批 2**：拆文件 + `@covers`，按文件提交。
4. **批 3**：淘汰，逐条登记，单独提交。
5. 每批完成后跑 `npm run typecheck`、`npm run lint`、`npm run test:unit`（批 1 还跑 `verify-local` 单次）；失败先回滚该批。
6. 全部完成后跑 `flaky-check --runs 5`、`ci-timings`，把证据填进 `acceptance.md`。
7. **回滚策略**：每批一个提交，`git revert <sha>` 即可回到上一批状态；预算常量首次写入后不随回滚丢失（在批 1 提交里）。
8. **发布**：合回 `dev` 后由 CI 跑新检查；检查失败先修脚本或用例，不关闭检查。

## 历史 Bug 命中结论

- 读了 `docs/modules/scripts/README.md`（无 Bug 索引文件、`docs/modules/scripts/`（该目录没有 bugs.md） 为空）、`docs/modules/server/bugs.md`（7 条）、`docs/modules/server-exec/bugs.md`（5 条）、`docs/modules/web/bugs.md`（18 条）。
- **未命中历史 Bug**：没有「测试偶发失败 / 并发超时 / flaky / 用例预算」类记录。`server-exec/bugs/pi-bridge-tools-timeout.md` 是产品侧上游超时，`web/bugs/*` 是界面状态类，均与本次测试基建无关。
- 相关**项目教训**（不是 Bug），设计已遵循：
  - `lmvp3it161tuk`：时间敏感单测分两批跑（计时串行、其余并行）——D5 保留该机制并给出收缩依据。
  - `lmvq27ybapgda`：子对话 worktree 跑全量单测用祖先目录的 tsx——D10 的验收入口沿用现有解析方式。
  - `lmvq64pdbulcy`：单测断言不写死中文——D9 的检查脚本。
  - `lmvkhbpv29e57`：跑会自己 push 的测试要清 `GIT_CONFIG_*`——D7/D9 的环境清理。
