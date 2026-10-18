# API 与契约

## 适用场景

HTTP、RPC、消息、插件 API、跨模块接口、SDK 和长期序列化格式。

## 决策问题

契约至少定义输入、输出、错误、认证授权、幂等、分页、限流、版本、兼容窗口和退役策略。内部模型与外部契约生命周期不同时使用边界 DTO。

## 候选方案与取舍

- 同步调用：明确即时结果，但形成时间耦合。
- 异步消息：削峰和解耦可用性，但引入重复、乱序和最终一致。
- additive 演进：首选；先扩展、迁移、观察，再收缩。
- 新 major 版本：语义或结构不可兼容时使用。

## 强制约束

- MUST 明确兼容方向、支持版本和最长滞留时间。
- MUST 为写操作定义幂等及结果查询语义。
- MUST 使用结构化、稳定、可机器判定的错误模型。
- MUST NOT 直接发布 ORM 实体、内部类序列化结果或第三方 SDK 类型。
- MUST NOT 原地改变字段类型、单位或语义。
- SHOULD 让消费者忽略未知字段，并保存历史 payload 做回放。

## 反模式

要求所有消费者同步上线；optional 改 required；删除字段却无使用指标；消息契约没有 schema version；以 HTTP 200 代替业务最终成功；契约测试过度匹配无关字段。

## 验证方式

OpenAPI/schema diff；生产者×消费者版本矩阵；消费者驱动契约；历史 payload 回放；N-1/N 混跑；未知字段、枚举和缺失字段测试；退役前真实调用量检查。

## 主要依据

- https://learn.microsoft.com/azure/architecture/best-practices/api-design
- https://martinfowler.com/bliki/ParallelChange.html
- https://docs.pact.io/
- https://www.rfc-editor.org/rfc/rfc9110.html
