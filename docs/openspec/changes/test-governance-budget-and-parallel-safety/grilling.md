# Grilling · 测试治理与执行预算

change：`test-governance-budget-and-parallel-safety`
日期：2026-10-27

## 阶段 0 事实（已核对，不是设计选择）

- 环境：Windows 开发机 + WSL Ubuntu-24.04；OpenSpec 1.14.1；文档根（DOC_ROOT）为 `docs/`。
- 初始化命令：`cd docs && openspec init --tools pi --no-animation`（exit 0）。
- 产物：`docs/openspec/config.yaml`（`schema: spec-driven`，未填自定义 context/rules）、`docs/openspec/changes/archive/.gitkeep`、`docs/openspec/specs/.gitkeep`。
- 副作用：init 顺带在 `docs/` 下生成过 `.pi` 指令目录（6 个指令）与 skills 目录，命中仓库 `.gitignore` 里排除 `.pi/` 的那一行，**不会入库**，本次也没有把它们纳入仓库；仓库根 `AGENTS.md` 未被改动（`git diff --stat` 为空），也没有生成 `AGENTS.md`。
- 现状规模（父对话实测，本 change 直接采用，未重复统计）：单测 238 文件 / 2119 用例（server 136、shared 54、web/src 48）；e2e 13 个分片（编号 01–08、10–14，无 09；父对话给的是 14，按 `scripts/e2e/` 实际收集为 13）；界面检查 12 个分片；本地六步整体 6m5s，单测 2m53s–6m44s，e2e 1m13s–6m，界面检查 1m10s–5m35s。
- 现状并发：`scripts/unit-tests.mjs` 只在 `TIMING_FILES`（5 个文件）串行，其余交给 `node --test` 默认并发（CPU 核数）；`scripts/e2e.mjs` 固定默认 4 片；`scripts/ui-check.mjs` 默认 `min(分片数, availableParallelism())`，受 `AGENT_PANEL_UI_CONCURRENCY` 覆盖。
- 现状隔离：e2e 每个分片 `mkdtempSync` 自己的 `AGENT_PANEL_DATA`，服务 `listen(0)` 后从 stdout 回报 `AGENT_PANEL_PORT`；界面检查每个分片自己的静态服务、浏览器和演示数据。

## 决策

### Q1 治理范围

❓ 这轮治理要覆盖哪几项？

➡️ 推荐：六项一起做。它们互相耦合——只做耗时会把用例删掉换速度，只做预算不解决并发会继续假失败。

- [x] 六项全部，写进同一份 change（预算与分层、flaky 隔离与自动重试、并行度自适应、语言环境默认化、影响面筛选细化、过期用例淘汰）
- [ ] 只做耗时（并行度自适应 + flaky 隔离）
- [ ] 只做用例预算与淘汰

用户答复：全选 6 项。
结论：拆成 4 份 capability 承载（`test-layering-and-budget`、`test-execution-stability`、`test-impact-selection`、`test-environment-defaults`），六项方向逐条对应到需求，不合并成一条笼统要求。

### Q2 验收标准

❓ 用什么口径判定这次治理成功？

➡️ 推荐：全部用可执行命令和可观测指标，不接受「明显变快」。

- [x] 本地六步整体验证 ≤ 4 分钟（现状实测 6m5s）
- [x] 单测 ≤ 3 分钟、e2e ≤ 3 分钟、界面检查 ≤ 2 分钟
- [x] 连续 5 次全量跑无 flaky
- [x] CI 的 test job ≤ 10 分钟

用户答复：照此口径。
结论：每条指标在 spec 里都带核对方式（命令、次数、统计口径），在 `acceptance.md` 里逐条登记证据。

### Q3 用例预算

❓ 用例数只增不减怎么管？

➡️ 推荐：按层设硬预算 + 超预算强制替换，不靠自觉。

- [x] 硬预算 + 强制替换：按纯函数 / 集成 / e2e 分开设上限；超预算时新增必须合并或淘汰等量旧用例，提交说明写清「覆盖了哪个能力、删的靠什么替代」
- [ ] 只做软提醒（报告超预算但不阻断）
- [ ] 只靠评审口头把关

用户答复：硬预算 + 强制替换，且不许为了缩短时间直接删测试。
结论：预算检查做成可执行脚本并接入 `lint` 与 CI；淘汰只允许三类理由（能力已删除 / 被更强断言完全覆盖 / 长期 flaky 且修复成本高于价值），每类都要留证据。

### Q4 承载方式

❓ 这次 delta 放哪、要不要顺带补模块文档？

➡️ 推荐：新建 change 承载，主 specs 为空、没有强关联候选；测试基础设施一直没有模块文档，排查要从脚本里从头读。

- [x] 新建 change；同时补 `docs/modules/testing/README.md`（入口脚本、分片结构、各层边界、怎么跑、怎么加用例），并同步 `docs/MODULE-MAP.md` 表格行
- [ ] 只新建 change，不补模块文档

用户答复：新建 change + 补模块文档。
结论：`docs/modules/testing/` 作为独立模块登记进模块地图；`docs/agent-test-steps.md` 保持「能力块与测试步骤」的职责，不重复写测试基础设施细节。

### Q5 change 名称（Agent 自决）

按 kebab-case 和「一个 change 一个可验收能力」的惯例，取名 `test-governance-budget-and-parallel-safety`，覆盖预算、分层、并发与稳定性四条主线。用户与父对话已采纳。

### Q6 技术路线（用户要求设计必须落到可执行）

❓ 迁移、并发、与另一条父对话的关系怎么处理？

➡️ 推荐：见 `design.md` 的「Decisions」D1–D10，逐条给落地位置和验证命令。

- [x] 迁移按「先统计基线、再分批改文件名与目录、每批跑全量对比用例名集合」，不按文件内碎片化拆；
- [x] 并发统一走一个纯函数（CPU / 可用内存 / 显式环境变量取小），`AGENT_PANEL_UI_CONCURRENCY` 保留为上限之一；
- [x] 默认英文环境依赖另一条父对话的改动，本 change 只补断言规范、检查与验收，不重复实现同一件事。

用户答复：按这三条写进 design。
结论：`design.md` 对应章节 D3（迁移）、D6–D7（并发与隔离）、D9（语言环境依赖关系）。

## 硬约束（spec / design 必须显式遵守）

- `TIMING_FILES` 串行清单不能简单删除：收缩要有依据（真实时钟断言、并发窗口），替代机制是断言侧改造（可注入时钟 / 事件驱动 / 窗口 ≥ 实测 p99 的 2 倍）+ 文件级隔离重跑；串行只降低争用概率，不能消除时钟漂移（实测反例：串行批里仍有 5599ms 超 4000ms 窗口）。
- `AGENT_PANEL_UI_CONCURRENCY` 继续有效；显式环境变量是自动建议的**上限**（设得更大不抬高自动值）。
- e2e 必须在 WSL（Ubuntu-24.04）里跑；非 WSL 环境要明确报告环境不满足，不能假装跑过。
- 演示后端与正式后端响应字段一致；界面检查不因字段差异失败。
- 单测断言不写死中文（项目教训 `lmvq64pdbulcy`）。
- 本阶段只写 `docs/openspec/` 与 `docs/modules/testing/`，不动测试代码、CI、`scripts/`；阶段 3 由父对话另行通知。
- 不触碰 `server/web-search.test.ts`、`shared/web-search.ts`（另一条子对话在改）。

## 非目标

- 不处理 `openspec init` 生成的临时指令目录（`docs/` 下、被 `.gitignore` 排除、未入库、现已被清理）的可复现性问题：新环境需先在 `docs/` 下跑 `openspec init`（或 `openspec update`）。用户选择纳入版本控制或改由项目 `skills/` 承载时，另开 change。
- 不改产品功能、界面行为和执行引擎的语义；本次只治理测试基础设施与验证方式。
- 不引入外部测试服务（远程缓存、云测试平台）或新的测试框架。
- 不为了达标删除测试：减少耗时只能来自分层、并发、选择精度和淘汰规则。
