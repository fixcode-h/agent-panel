---
name: software-architecture-design
description: 设计或评审项目、子系统与框架架构，确定复杂度级别、模块边界、依赖方向、运行时数据、状态生命周期、契约、一致性、可靠性、扩展性及可验证约束。用户提到架构设计、框架设计、模块拆分、依赖治理、数据流、技术选型或架构评审时使用；普通局部功能、单文件修复或已批准架构的代码骨架创建不使用。
user-invocable: true
---

# 软件架构设计

目标不是套用流行模式，而是在业务约束、质量属性、团队能力和演进成本之间，选择当前最简单且可持续验证的结构。

## 职责边界

本技能负责：

- 识别质量属性、业务不变量、信任边界和运行约束；
- 确定系统、模块、数据、生命周期、依赖和部署边界；
- 比较候选架构及其成本、风险、适用条件和退出条件；
- 把关键架构特征转成测试、静态规则、预算、指标或演练；
- 为后续实现提供明确的架构契约。

本技能不负责：

- 替代 `brainstorming` 收敛需求或批准方案；
- 替代 `domain-modeling` 定义领域词汇；
- 替代 `project-documentation` 决定文档路径；
- 建立与 `openspec` 平行的任务或验收流程；
- 在架构尚未确认时创建代码骨架；
- 把语言风格、格式化或框架 API 用法伪装成架构规则。

## 执行流程

### 1. 建立事实基线

先读取最小必要上下文：项目入口、现有架构、领域模型、相关 ADR、技术契约、构建与测试配置，以及受影响模块。不要仅凭目录名推断真实边界。

至少确认：

- 业务目标、关键用例与不可破坏的不变量；
- 规模、延迟、吞吐、可用性、恢复和安全目标；
- 部署模型、团队所有权、版本兼容窗口和运维能力；
- 当前主要痛点的证据，而不是假设中的未来需求；
- 技术栈、运行时版本和既有约束。

需求、术语或边界仍不明确时，回到对应上游技能，不用架构模式掩盖需求缺口。

### 2. 评估复杂度与架构适配

总是先读 `references/architecture-fit-and-complexity.md`。选择最小充分结构：

- 简单、稳定、局部应用：直接结构或轻量分层；
- 多业务能力但仍共同部署：模块化单体；
- 核心规则需隔离多个入口与基础设施：端口与适配器；
- 边界稳定且确需独立交付、扩缩容或故障隔离：分布式服务。

不得使用代码行数、实体数量或“未来可能扩展”作为拆服务的唯一依据。

### 3. 选择最小 reference 集

按实际风险读取，不要一次加载全部资料：

| 问题 | Reference |
| --- | --- |
| 模块职责、依赖方向、单体与服务边界 | `references/modules-and-dependencies.md` |
| 表格、配置、运行时投影、静态/动态数据 | `references/runtime-data-projection-and-configuration.md` |
| 对象状态、所有权、初始化、销毁 | `references/state-lifecycle-and-ownership.md` |
| HTTP/RPC/消息/API 兼容 | `references/api-and-contracts.md` |
| 事务、数据所有权、事件、迁移 | `references/persistence-and-consistency.md` |
| 缓存、失效、陈旧预算 | `references/caching.md` |
| 并发、异步、取消、背压 | `references/concurrency-and-async.md` |
| 超时、重试、幂等、降级、恢复 | `references/reliability-and-errors.md` |
| 插件、策略、变化轴、扩展点 | `references/extensibility.md` |
| 延迟、吞吐、内存、容量 | `references/performance.md` |
| 日志、指标、追踪、SLO | `references/observability.md` |
| 信任边界、授权、秘密、供应链 | `references/security-boundaries.md` |
| 测试组合与架构适应度函数 | `references/testing-and-fitness-functions.md` |
| 遗留改造、兼容窗口、渐进迁移 | `references/evolution-and-migration.md` |
| Unreal Engine 项目 | `references/unreal-engine-architecture.md` |
| C#/.NET 项目 | `references/csharp-dotnet-architecture.md` |
| 通用 Lua 设计 | `references/lua-architecture.md` |
| Lua 与 C/C++/C#/游戏宿主互操作 | `references/lua-host-integration.md` |

### 4. 形成候选方案

给出 2–4 个真实可行方案。每个方案必须包含：

- 适用前提与淘汰条件；
- 模块、数据、控制流和依赖方向；
- 一致性、故障、性能、安全与运维影响；
- 当前成本、持续成本和迁移成本；
- 哪些复杂度被消除，哪些复杂度只是被转移。

若只有一个合理方案，也要说明其他方案因何不成立。

### 5. 输出架构契约

推荐方案必须明确：

- 模块职责与非职责；
- 公开接口、数据所有者和唯一事实源；
- 对象生命周期、状态机和初始化不变量；
- 同步、异步、事务及失败边界；
- 允许和禁止的依赖；
- 扩展点及其真实变化轴；
- 性能、安全、可靠性和兼容预算；
- 迁移、回滚与退役路径。

使用 `MUST`、`MUST NOT`、`SHOULD` 时，必须同时写出适用范围与验证方式。无法验证的口号不能作为强制约束。

### 6. 设计验证

为关键架构特征定义适应度函数：

- 静态依赖检查和循环检测；
- 单元、属性、集成、契约和端到端测试；
- 性能预算、容量测试和内存分析；
- 故障注入、恢复演练和迁移演练；
- SLI/SLO、告警和趋势指标；
- 安全扫描、授权矩阵和威胁场景。

每项验证写清保护的风险、阈值依据、执行频率、失败处置和所有者。

## 决策纪律

- 优先组合而非继承，优先明确依赖而非 Service Locator。
- 优先强类型或可验证契约，避免原始外部模型穿透核心业务。
- 优先不可变快照和原子发布，避免共享可变半成品。
- 优先有界资源和显式过载策略，禁止无界队列与无限重试。
- 优先渐进迁移和可回滚切片，避免大爆炸重写。
- 没有真实变化轴、性能证据或隔离需求时，不增加抽象、缓存、异步或服务边界。
- 架构模式是候选工具，不是完成目标；项目可以在不同模块采用不同内部结构。

## 产出路由

- 当前变更中的目标架构写入 OpenSpec `design.md`；
- 已落地的模块、依赖与数据流更新 `architecture.md`；
- 难逆转、有惊讶性且存在真实权衡的决策才写 ADR；
- API、持久化、资源格式等稳定跨模块约束写入 `tech/`；
- 架构确认后，需要创建项目或模块骨架时，交给 `project-scaffolding` 技能。
