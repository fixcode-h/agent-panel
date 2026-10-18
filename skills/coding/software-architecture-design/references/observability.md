# 可观测性

## 适用场景

跨模块/服务调用、异步工作流、生产诊断、SLO 和架构验证。

## 决策问题

从关键用户流和故障问题反推信号：指标回答趋势，Trace 回答因果链，日志记录离散状态和审计。OpenTelemetry 负责信号，不替代业务 SLO。

## 候选方案与取舍

入口统一上下文传播；异步 fan-out 使用正确父子关系或 links；低基数指标聚合；结构化日志关联 trace；head sampling 控成本，tail sampling 保留完整结果但增加状态成本。

## 强制约束

- MUST 使用标准上下文传播并统一服务资源身份。
- MUST 记录版本、配置代次、重试、队列年龄和最终业务结果等关键维度。
- MUST NOT 把用户 ID、订单 ID、原始 URL 等无界值作为指标标签。
- MUST NOT 记录凭据、Token、秘密和不必要 PII。
- MUST 监控遥测管道自身的丢弃、队列、延迟和失败。
- SHOULD 以 SLO burn rate 而非单点阈值驱动关键告警。

## 反模式

每个服务新建 root trace；日志文本拼接；仅 HTTP 200 代表异步流程成功；低采样率却无错误保留策略；Collector 单点；遥测缺口被解释为业务健康。

## 验证方式

跨服务 trace 传播；批量消息 links；金丝雀秘密零检出；高基数压力；Collector 断连/限流/重启；合成成功、失败和慢请求验证 SLI 数学及告警。

## 主要依据

- https://opentelemetry.io/docs/specs/
- https://opentelemetry.io/docs/collector/resiliency/
- https://sre.google/sre-book/service-level-objectives/
