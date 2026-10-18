# 并发与异步

## 适用场景

并行任务、消息消费、后台工作、流处理、游戏任务和异步 I/O。

## 决策问题

先确定执行模型、共享状态、顺序要求、最大在途量、取消语义和过载行为。异步解决等待，不自动提升吞吐；并发度必须由下游容量决定。

## 候选方案与取舍

- 单线程/Actor：状态简单，吞吐受单执行器约束。
- 任务并发：适合独立 I/O，需结构化生命周期。
- Worker 队列：削峰但引入排队、新鲜度和重放。
- 并行计算：适合可分割 CPU 工作，需证明收益大于调度成本。

## 强制约束

- MUST 为队列、线程池、连接池和在途任务设置上限。
- MUST 定义队列满时阻塞、拒绝、降级或丢弃策略。
- MUST 传播 deadline/cancellation，并停止启动无价值工作。
- MUST 让子任务从属于父作用域；持久后台任务必须显式移交。
- MUST NOT 假设取消可以撤销已提交副作用。
- SHOULD 对相同键构建使用 single-flight，并限制 fan-out。

## 反模式

无界队列；fire-and-forget 持有请求资源；每层独立 timeout；取消后继续昂贵工作；增加线程掩盖慢下游；并发回调无顺序或所有权约束。

## 验证方式

将下游降到正常吞吐 10%；队列满和取消注入；检查内存/任务数封顶；并发竞态和死锁检测；最老任务年龄、在途数、拒绝率、consumer lag 与排空时间监控。

## 主要依据

- https://www.reactive-streams.org/
- https://learn.microsoft.com/azure/architecture/patterns/queue-based-load-leveling
- https://pkg.go.dev/context
