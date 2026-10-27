# Spec Delta · test-execution-stability

## Purpose

让测试失败可归因、可复现：失败先隔离重跑再下结论，串行清单只保留有证据的条目，并发按机器能力计算，分片之间资源互不干扰。

## ADDED Requirements

### Requirement: Bounded failure retry

单个测试文件或分片失败时 MUST 先隔离重跑：总尝试次数上限 3 次（首次 + 最多 2 次重跑）；禁止整轮重跑、禁止无限重试。退出码 MUST 分三段：0 = 本次没有失败（包括重跑后通过）；1 = 真失败（3 次尝试都失败）；flaky（重跑后通过）返回 0，但 MUST 写入 `flaky-report.json`，并由 CI 的独立步骤读取它判红，不得只靠退出码放行。真失败 MUST 保留首次的完整输出。

#### Scenario: 重跑通过时标记 flaky 且退出 0

- **WHEN** 某测试文件首次失败、隔离重跑第 2 次通过
- **THEN** 退出码为 0，`flaky-report.json` 列出该文件与失败用例名并保留首次失败输出，CI 的独立步骤读报告后把这次运行判红

#### Scenario: 三次尝试都失败时判真失败

- **WHEN** 同一文件首次失败、两次隔离重跑也失败
- **THEN** 整体以非零退出，输出首次失败的报错原文，不再继续重试

#### Scenario: 不允许整轮重跑

- **WHEN** 实现者想用「重新跑一遍全量」来绕过偶发失败
- **THEN** 验收脚本按本需求拒绝：重试只发生在失败的文件或分片粒度

### Requirement: Timing serial list justification

计时文件串行清单（`TIMING_FILES`）的每个条目 MUST 有证据：该文件包含真实时钟断言或依赖并发窗口。新增条目 MUST 附上可复现的失败记录；未改造的条目暂时留在清单里时 MUST 登记打算用哪一条改造（见 Timing assertions are decoupled from real clock）；移除条目 MUST 先满足该需求的三条出路之一，再证明该文件在**目标并发配置下连续 3 次全量运行**通过（并发上限已按 Adaptive parallelism 需求生效，不是只跑该文件），并记录并发值、机器配置和移除日期。串行清单 MUST NOT 作为并发问题的首选修复手段。

#### Scenario: 无证据新增被拒绝

- **WHEN** 提交只把文件加进串行清单，没有失败输出或时钟断言说明
- **THEN** 检查或评审判为不合规，不合并

#### Scenario: 移出清单前连续三次全量通过

- **WHEN** 文件已按 Timing assertions are decoupled from real clock 改造过，且在目标并发配置下（D6 的上限已生效）连续 3 次全量运行都通过
- **THEN** 允许从清单移除，报告记录 3 次全量运行的结果、并发值、机器配置和移除日期

#### Scenario: 只靠串行不算稳定

- **WHEN** 某文件只在串行清单里有条目，断言仍是固定窗口的真实时钟比较，没有做任何断言侧改造
- **THEN** 不判为稳定用例，也不允许以「已经在串行批里」为理由把该失败关掉或只调批次

#### Scenario: 移出后再次失败则带回证据加回

- **WHEN** 文件移出清单后在全量运行中失败
- **THEN** 加回清单，并附上这次失败的输出作为证据

### Requirement: Timing assertions are decoupled from real clock

测试里出现真实时钟断言（`Date.now()` 差值、用 `setTimeout` 轮询等信号、落盘/退出窗口这类依赖墙钟的等待）时 MUST 满足下列三条之一，否则 MUST NOT 被判为稳定用例：

1. 用可注入时钟 / 假时钟（`node:test` 的 `mock.timers`，或把 `now()` / `sleep()` 作为依赖传入）；
2. 改成事件驱动：等信号（子进程退出事件、Promise、带上限的条件轮询）而不是固定 sleep 轮询；
3. 保留真实时钟，但窗口 MUST ≥ 实测 p99 的 2 倍，并在断言处用注释写明实测依据（样本数、机器配置、日期、p99 值）。

串行清单只降低与其他测试文件抢 CPU 的概率，**不能**消除真实时钟漂移：同一个断言在串行批里同样会超窗。因此计时类失败 MUST NOT 以调批次 / 把文件加进串行清单作为首选修复手段。

#### Scenario: 串行批里仍然超窗时判为时钟漂移

- **WHEN** `server/background.test.ts` 的 `assert.ok(Date.now() - t0 < 4000)` 在 `TIMING_FILES` 串行批里实跑 5599ms 失败
- **THEN** 归因为「靠真实时钟轮询」，按本需求选一条出路改造（注入时钟 / 事件驱动 / 窗口 ≥ 2× p99），不得以再加一个串行条目或调整批次收尾

#### Scenario: 放宽窗口要留实测依据

- **WHEN** 选择保留真实时钟
- **THEN** 窗口按实测 p99 的 2 倍取值（`server/background.test.ts` 实测 p99 ≥ 5599ms，所以窗口至少 11198ms：现有 4000ms 不满足 2 倍 p99，必须上调），断言旁的注释写明 p99 的实测样本、机器配置与日期；写不出实测依据时改用前两条

#### Scenario: 轮询等待改成等信号

- **WHEN** 用例用 300ms 一次的 `setTimeout` 轮询等后台命令排队 / 启动
- **THEN** 改成等事件信号（子进程事件、状态变更回调、带上限的条件轮询），断言里不再出现固定睡眠时长作为等待手段

### Requirement: Adaptive parallelism

单测、e2e、界面检查的并发 MUST 由同一个纯函数计算：`min(CPU 建议, 内存建议, 显式环境变量, 单元总数)`。显式环境变量是**上限**不是覆盖——设得比自动建议大时仍取自动建议，设得更小时取它；`AGENT_PANEL_UI_CONCURRENCY` MUST 继续生效。由 verify-local 并行启动时，MUST 以它传入的预算（带 `AGENT_PANEL_CONCURRENCY_BUDGET_FROM=verify-local` 标记）为上限、跳过内存自算；用户手动设置的变量没有该标记，仍按内存建议取小。实际并发值与生效来源（CPU / 内存 / 环境变量 / 单元数 / 透传预算）MUST 写进运行日志。

#### Scenario: 内存不足时压低并发

- **WHEN** 机器有 32 个逻辑核、可用内存只够 3 个界面检查浏览器单元
- **THEN** 界面检查并发取 3，日志写明「受内存限制，建议 3」

#### Scenario: 环境变量更小时压低并发

- **WHEN** 自动计算建议 6，用户设置 `AGENT_PANEL_UI_CONCURRENCY=2`
- **THEN** 实际并发为 2，日志写明来源是环境变量

#### Scenario: 环境变量更大也不能突破内存限制

- **WHEN** 自动计算因内存只能建议 2，用户设置 `AGENT_PANEL_UI_CONCURRENCY=12`
- **THEN** 实际并发为 2，日志写明「受内存限制，环境变量不抬高上限」

#### Scenario: verify-local 透传的预算优先

- **WHEN** verify-local 启动时传入预算 3 和 `AGENT_PANEL_CONCURRENCY_BUDGET_FROM=verify-local`，用户又手动设了 `AGENT_PANEL_UI_CONCURRENCY=12`
- **THEN** 实际并发为 3，日志注明「预算由 verify-local 分配」；同一个用户设置单跑（没有来源标记）时仍受内存限制取 auto

#### Scenario: 并发不超过单元总数

- **WHEN** 界面检查只有 12 个分片、自动计算建议 32
- **THEN** 实际并发取 12，不会启动空槽位

### Requirement: Shard resource isolation

每个 e2e 分片和界面检查分片 MUST 独占可写数据目录、动态分配的端口和独立日志。端口 MUST 由服务 `listen(0)` 后回报实际值，分片 MUST NOT 使用固定端口或共享可写目录。端口冲突或实例标识重复时 MUST 明确失败，并在报错里指出分片名。

#### Scenario: 并行分片各有独立资源

- **WHEN** 同时运行 8 个 e2e 分片
- **THEN** 每个分片的数据目录路径互不相同、实际监听端口互不相同，假 CLI 日志各自落在自己目录

#### Scenario: 端口冲突时明确失败

- **WHEN** 某个分片的服务无法监听或被残留进程占用
- **THEN** 该分片失败并输出分片名、期望的实例标识和实际冲突信息，不被当作普通用例失败

### Requirement: Environment inheritance is cleared

测试入口 MUST 在启动子进程前清理会改变行为的继承变量（`AGENT_PANEL_*`、`GIT_CONFIG_*` 一类），并显式设置本次运行需要的值。分片 MUST NOT 继承上一轮运行留下的数据目录或端口。

#### Scenario: 继承的数据目录被覆盖

- **WHEN** 父进程带着 `AGENT_PANEL_DATA` 启动 e2e 总入口
- **THEN** 每个分片使用自己新建的临时目录，日志显示分片的实际数据目录，不使用父进程的值
