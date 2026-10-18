# 持久化与一致性

## 适用场景

事务、跨服务流程、事件发布、读写模型、数据库迁移和持久化版本。

## 决策问题

先列业务不变量、唯一事实源和数据所有者，再划事务边界。强一致需求无法被补偿时应调整边界，而不是默认使用 Saga。

## 候选方案与取舍

- 单库本地事务：优先维护同一所有者的不变量。
- Outbox：业务更新与待发事件同事务，消费者仍需幂等。
- Saga：跨所有者长流程，显式中间状态和补偿。
- 投影/CQRS：读写形态差异大且允许有界陈旧时使用。

## 强制约束

- MUST 在数据库约束层保护关键唯一性与范围不变量。
- MUST NOT 在持锁事务中执行网络调用或用户等待。
- MUST 为重放写入提供稳定幂等键和业务唯一约束。
- MUST 让投影可重建、可重复消费并携带来源版本。
- MUST 对 Schema 采用 Expand-Migrate-Contract 和可恢复回填。
- MUST 记录跨服务流程状态、超时、补偿和人工处理路径。

## 反模式

检查后插入却无唯一约束；数据库提交后直接 publish；假设 exactly-once；跨服务共享写表；一次性大事务回填；以最终一致掩盖无收敛时限和修复机制。

## 验证方式

提交前后崩溃注入；重复与乱序消息；并发不变量属性测试；Outbox 五个故障窗口；投影从空库重建；迁移中断恢复；新旧读双跑 checksum；Saga 状态机模型测试与对账。

## 主要依据

- https://www.postgresql.org/docs/current/transaction-iso.html
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
- https://martinfowler.com/articles/patterns-of-distributed-systems/saga.html
- https://martinfowler.com/bliki/ParallelChange.html
