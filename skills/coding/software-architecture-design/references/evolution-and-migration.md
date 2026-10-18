# 演进与迁移

## 适用场景

遗留系统重构、模块提取、服务化、Schema/API 升级和技术替换。

## 决策问题

同时设计目标架构与每个中间状态。迁移切片应产生可独立验收的业务价值，并可发布、观察、回滚和退役。

## 候选方案与取舍

- Strangler Fig：按端到端业务切片逐步替换。
- Parallel Change：Expand、迁移、Contract。
- Branch by Abstraction：长期替换内部实现但保持稳定入口。
- 影子读/写、双跑：提高信心但增加一致性和运营成本，必须有退出计划。

## 强制约束

- MUST 记录当前/目标所有者、路由、数据同步、兼容、回滚和退役条件。
- MUST 使用可恢复、幂等、小批次回填及 checkpoint。
- MUST 为双写、CDC 和影子流量建立对账。
- MUST 在删除旧结构前确认代码、脚本、BI、ETL、消息积压和回滚版本均不依赖它。
- MUST NOT 把大爆炸重写作为默认方案。
- SHOULD 按价值、边界清晰度、耦合和风险选择迁移顺序。

## 反模式

水平替换所有技术层却无可交付能力；永久双写；目标架构可运行但中间状态不可运行；只验证行数；迁移完成以“代码已写”而非旧路径退役判断。

## 验证方式

生产规模演练；中断恢复；新旧结果 checksum 和业务聚合对账；N/N-1 混跑；流量切换与回滚；依赖使用量归零；迁移期间延迟、锁、日志增长和错误预算监控。

## 主要依据

- https://martinfowler.com/bliki/StranglerFigApplication.html
- https://martinfowler.com/bliki/ParallelChange.html
- https://cloud.google.com/architecture/microservices-architecture-refactoring-monoliths
