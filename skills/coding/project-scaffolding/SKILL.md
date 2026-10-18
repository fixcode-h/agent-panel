---
name: project-scaffolding
description: 根据已经确认的架构创建或调整项目、服务、模块与插件的最小可运行代码骨架，包括目录、入口、组合根、依赖配置、基础测试和构建验证。用户要求初始化项目、搭建代码框架、创建模块骨架或把批准架构落地时使用；架构或技术栈尚未确定、普通功能开发和仅讨论目录设计时不使用。
user-invocable: true
---

# 项目骨架落地

本技能把已确认的架构契约落实为最小、可构建、可测试、可继续演进的结构，不负责重新选择架构。

## 前置门禁

开始前必须具备：

- 项目类型、技术栈和版本；
- 模块职责、依赖方向和公开边界；
- 状态、数据、配置和资源所有权；
- 入口、后台工作和关闭语义；
- 最低构建、测试与运行验收条件。

缺少会改变目录、依赖或部署边界的决策时，返回 `software-architecture-design`。现有仓库优先遵循已有布局、工具链与命名，不引入第二套体系。

## 执行步骤

1. 读取项目结构、构建清单、测试入口、CI、架构文档和相关任务。
2. 判断是 greenfield、现有模块扩展还是 brownfield 渐进改造。
3. 选择最小 archetype，不创建没有当前职责的层、接口或空目录。
4. 先建立依赖边界、模块入口和组合根，再添加最小行为切片。
5. 接入配置、日志、健康、关闭和资源生命周期，但只加入当前部署模型需要的能力。
6. 建立 smoke test、关键架构规则和构建命令。
7. 运行项目同等 CI 检查，修复失败后再声明完成。

## Reference 路由

| 场景 | Reference |
| --- | --- |
| 选择最小骨架类型 | `references/scaffold-fit-and-archetypes.md` |
| 目录、模块、依赖可见性 | `references/layout-and-module-boundaries.md` |
| 入口、组合根、配置 | `references/bootstrap-composition-and-configuration.md` |
| DTO、适配器、生成代码 | `references/contracts-adapters-and-code-generation.md` |
| 资源、后台任务、关闭 | `references/resource-lifecycle-and-background-work.md` |
| 数据库、本地环境、迁移 | `references/data-migrations-and-local-development.md` |
| 测试与架构门禁 | `references/test-harness-and-fitness-gates.md` |
| 运维、安全、供应链最低基线 | `references/operational-and-security-baseline.md` |
| 遗留项目渐进采用 | `references/brownfield-adoption-and-evolution.md` |

涉及 UE、C# 或 Lua 时，先按 `software-architecture-design` 的相应技术栈 reference 确认运行时约束，再落地骨架。

## 最小产出

按项目实际需要选择，不强制全部创建：

- 一个可构建的模块/应用入口；
- 一个集中组合根；
- 明确的 public/internal 边界；
- 一个最小端到端行为切片；
- 一个 smoke test 和必要的架构测试；
- 可执行的 build/test/run 命令；
- 受控配置示例，不包含秘密；
- 适用时的健康、优雅关闭和迁移入口。

## 禁止事项

- 不因“以后可能需要”创建微服务、消息队列、缓存、仓储层或插件系统。
- 不生成大量示例业务、空接口、透传 Manager 或万能 Base 类。
- 不覆盖用户已有代码、构建配置或未提交改动。
- 不自动运行不可逆生产迁移、发布、推送或远端操作。
- 不把 scaffold 成功等同于业务完成；骨架只证明结构和装配可用。
