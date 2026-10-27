# Acceptance

> 状态取值：待验证 / 通过 / 失败 / 延期（`deferred` / `accepted-risk`）。
> 阶段 3、4 回填证据：命令原文 + 关键输出行 + 日期；没有本轮新鲜证据不得写「通过」。

## 逐条 spec 需求

### test-layering-and-budget

| #   | 需求                         | 验证方式                                                                                                                                                         | 状态   | 证据 |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 1   | Test layer classification    | `node scripts/test-layers.mjs --report`；单测 scripts/lib/test-layers.test.mjs                                                                                   | 待验证 |      |
| 2   | Per-layer test budget        | `node scripts/test-budget.mjs --check`；超限 fixture 期望失败                                                                                                    | 待验证 |      |
| 3   | Test retirement criteria     | `node scripts/test-inventory.mjs --check-retire`：理由必须在固定枚举内、removed 与登记一一对应、用户 Bug 回归未被删；再跑 `node scripts/test-budget.mjs --check` | 待验证 |      |
| 4   | Verification time budget     | `node scripts/verify-local.mjs --runs 3`，看每步耗时与并行编排后的总墙钟中位数（不是分项相加）                                                                   | 待验证 |      |
| 5   | Flakiness-free acceptance    | `node scripts/flaky-check.mjs --runs 5`，看 5 次结果与 flaky 列表                                                                                                | 待验证 |      |
| 6   | CI test job budget           | `node scripts/ci-timings.mjs --runs 20 --branch dev --job test`，看 P95                                                                                          | 待验证 |      |
| 7   | Migration preserves coverage | `node scripts/test-inventory.mjs --diff`，removed 与 `migration.md` 逐条对应                                                                                     | 待验证 |      |

### test-execution-stability

| #   | 需求                                            | 验证方式                                                                                                                                                                        | 状态   | 证据 |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 8   | Bounded failure retry                           | 注入必失败文件看 3 次尝试后退出 1；注入首次失败文件看退出 0 + `flaky-report.json` 非空；再跑 `node scripts/flaky-check-report.mjs` 期望非零退出                                 | 待验证 |      |
| 9   | Timing serial list justification                | `node scripts/unit-tests.mjs timing`；每条移出记录 3 次**全量**运行结果（含并发值与机器配置），且该文件已按下面 9b 的三条出路改造过（只靠串行不算稳定）                         | 待验证 |      |
| 9b  | Timing assertions are decoupled from real clock | `node scripts/unit-tests.mjs --files server/background.test.ts` 连跑 3 次不再超窗；断言处的注释含实测 p99 样本、机器配置、日期与窗口倍数（≥ 2×，或改用注入时钟 / 事件驱动）     | 待验证 |      |
| 10  | Adaptive parallelism                            | `AGENT_PANEL_UNIT_CONCURRENCY=1` / `AGENT_PANEL_UI_CONCURRENCY=2` 跑对应入口；再设 `=12` 且内存只够 2 时确认仍取 2；verify-local 并行时确认以透传预算为准；核对日志并发值与来源 | 待验证 |      |
| 11  | Shard resource isolation                        | 跑 `node scripts/e2e.mjs 07`、`node scripts/ui-check.mjs 08-misc`；人为占端口核对报错含分片名                                                                                   | 待验证 |      |
| 12  | Environment inheritance is cleared              | 带 `AGENT_PANEL_DATA` / `AGENT_PANEL_TRAY` 跑入口，核对日志与分片数据目录                                                                                                       | 待验证 |      |

### test-impact-selection

| #   | 需求                             | 验证方式                                                                              | 状态   | 证据 |
| --- | -------------------------------- | ------------------------------------------------------------------------------------- | ------ | ---- |
| 13  | Selection reports hit basis      | `node scripts/changed-tests.mjs --since <基线>`，每个命中带理由                       | 待验证 |      |
| 14  | Case-level selection granularity | 单组命中输出「用例级命中」；跨组 / 不可定位输出退整文件原因                           | 待验证 |      |
| 15  | Justified full-run triggers      | 改 `docs/lessons/testing.md` 不触发全量；改 `shared/schema.ts` 输出触发类别与文件集合 | 待验证 |      |
| 16  | Reproducible selection           | 清缓存前后两次 `--json` 输出 diff 为空                                                | 待验证 |      |
| 17  | Empty selection is reported      | 干净工作区跑 `changed-tests.mjs`，输出带基线提示；改 `extension/**` 输出交给父对话    | 待验证 |      |

### test-environment-defaults

| #   | 需求                            | 验证方式                                                                                                                                                                                                                                                                                                                                      | 状态   | 证据 |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 18  | Default English locale          | 父对话落地后分别跑 `LANG=zh_CN.UTF-8 npm run test:unit`、`LANG=zh_CN.UTF-8 npm run test:e2e -- 03`（WSL 里）、`LANG=zh_CN.UTF-8 node scripts/ui-check.mjs 08-misc`（先 `npx vite build --mode demo`），三个入口日志都显示英文生效；单个用例设 `AGENT_PANEL_LANG=zh` 时只有该用例走中文（局部覆盖）；核对没有 `setLang('zh')` 这种全局切换写法 | 待验证 |      |
| 19  | Language-independent assertions | `npm run lint`（含 `test-locale-check`）；临时加中文断言核对失败                                                                                                                                                                                                                                                                              | 待验证 |      |
| 20  | WSL-only e2e                    | `npm run test:e2e:wsl` 通过；本机直接跑 `npm run test:e2e` 输出环境不满足并非零退出                                                                                                                                                                                                                                                           | 待验证 |      |
| 21  | Demo-backend parity             | `npx vite build --mode demo && node scripts/ui-check.mjs`；新增字段时核对两份后端                                                                                                                                                                                                                                                             | 待验证 |      |
| 22  | Clean inherited environment     | 带 `GIT_CONFIG_COUNT` / `AGENT_PANEL_*` 跑单测，核对被清理变量日志                                                                                                                                                                                                                                                                            | 待验证 |      |

## 延期验证

| 项          | 原因                                      | 影响                        | 建议执行者  | 验证步骤                                                        | 当前证据 | 状态     |
| ----------- | ----------------------------------------- | --------------------------- | ----------- | --------------------------------------------------------------- | -------- | -------- |
| CI P95 统计 | 依赖 `dev` 上 20 次历史运行，本地无法构造 | 验收第 6 条无法在合并前完成 | 父对话 / CI | `node scripts/ci-timings.mjs --runs 20 --branch dev --job test` | 待收集   | deferred |

## 本轮成本观察

| 指标               | 目标         | 实际 | 说明                                                                                                                 |
| ------------------ | ------------ | ---- | -------------------------------------------------------------------------------------------------------------------- |
| 非必要用户打断次数 | 0            | 0    | 阶段 0/2 只在拿到用户已确认的四项结论后执行，未再打断；当时生成的 `.pi` 指令目录的取舍由父对话单独处理，未阻塞本阶段 |
| 重复探索           | 0 次重复统计 | 0    | 规模数据直接采用父对话实测；本次只补统计了「含集成特征的测试文件数 = 72（全在 `server/`）」                          |
| 验证失败及修复     | 记录每次     | 0    | 阶段 0：`openspec init` 一次成功；阶段 2：`openspec validate` 首次即通过；未出现失败重试                             |
