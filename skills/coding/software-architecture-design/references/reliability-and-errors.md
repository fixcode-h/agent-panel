# 可靠性与错误

## 适用场景

外部调用、关键业务流、过载、故障隔离、降级和灾备。

## 决策问题

区分业务拒绝、输入错误、瞬态故障、永久技术故障、结果未知和数据损坏。每类错误定义是否重试、是否降级、是否补偿、用户可见语义与告警级别。

## 候选方案与取舍

超时限制资源占用；重试处理瞬态故障；熔断避免持续放大；bulkhead 限制爆炸半径；降级保留核心能力；幂等处理结果未知。它们不能互相替代。

## 强制约束

- MUST 从端到端 deadline 分配各跳预算。
- MUST 只重试瞬态且可安全重放的操作，使用指数退避、抖动和总预算。
- MUST 在调用链一个合适层负责重试，避免乘法放大。
- MUST 对副作用使用幂等键、状态查询或补偿。
- MUST 为关键流定义 SLI/SLO、错误预算、RTO 和 RPO。
- MUST 测试降级、恢复、failover 与 failback。

## 反模式

无限/固定间隔重试；所有错误都重试；默认超时；fallback 返回无限陈旧或错误数据；共享资源池导致全局雪崩；只验证备份成功不验证恢复。

## 验证方式

注入 429/503/超时/连接重置/响应丢失；热点租户和毒性请求；单实例/区/cell 故障；备份恢复；检查总尝试次数、长尾延迟、预算燃烧、降级状态和恢复时间。

## 主要依据

- https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
- https://sre.google/sre-book/addressing-cascading-failures/
- https://sre.google/sre-book/service-level-objectives/
