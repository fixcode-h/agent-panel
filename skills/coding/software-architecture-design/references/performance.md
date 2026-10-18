# 性能与容量

## 适用场景

延迟、吞吐、帧预算、内存、加载、批处理和容量设计。

## 决策问题

从用户场景定义端到端预算，再向组件分配。区分平均吞吐、长尾延迟、峰值、稳态、资源饱和与故障降级状态。优化必须有 profile 证据。

## 候选方案与取舍

批量减少往返但增加等待和内存；缓存降回源但增加一致性；并行降低单任务时间但争用资源；预计算减少运行成本但增加启动/发布成本；对象池仅适合高频创建且重置可靠的昂贵对象。

## 强制约束

- MUST 用 p95/p99、吞吐、错误、资源和饱和度表达预算。
- MUST 覆盖正常、峰值、突发、长稳态与 N-1 故障负载。
- MUST 为缓存、队列、连接和内存设置容量上限。
- MUST 优先消除算法、I/O 和 N+1 问题，再做微优化。
- MUST NOT 用微基准替代端到端测试。
- SHOULD 用生产级数据规模和相近拓扑验证。

## 反模式

只看平均值或 CPU；猜测热点；自动扩容替代容量规划；无限预加载；无测量使用池化；开发机小数据得出生产结论。

## 验证方式

基线、load/stress/spike/soak、性能悬崖、内存快照、分配 profile、调用图、查询计划、N+1 检测；变更前后对照并在 canary 检查真实业务与资源指标。

## 主要依据

- https://learn.microsoft.com/en-us/azure/well-architected/performance-efficiency/performance-test
- https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/perf_architecture_use_benchmarking.html
