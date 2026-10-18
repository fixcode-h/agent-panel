# 缓存设计

## 适用场景

热点读取、昂贵可复算结果、配置投影、资源缓存和下游削峰。

## 决策问题

缓存前先定义事实源、陈旧预算、缓存键、失效触发、失败降级、容量和一致性风险。没有测量证明瓶颈时不引入共享缓存。

## 候选方案与取舍

- 请求内缓存：生命周期短，一致性简单。
- 进程内缓存：低延迟，但多实例不一致且占每实例内存。
- 共享缓存：跨实例复用，但增加网络和运维故障面。
- Cache-Aside：通用默认；写入先提交事实源，再失效缓存。
- 版本化不可变缓存：适合配置快照和编译投影。

## 强制约束

- MUST 明确可接受陈旧时间，TTL 来自业务预算。
- MUST 让缓存键包含影响结果的租户、区域、语言、权限和语义版本。
- MUST 为填充、失效和慢读回写提供版本协议。
- MUST 绕过缓存执行权限撤销、余额、唯一性和库存扣减等强一致决策。
- MUST 设置内存、条目、并发填充和回源预算。
- SHOULD 使用 single-flight、TTL 抖动和负缓存防击穿。

## 反模式

缓存即事实源；永久 TTL；先删缓存再写库；数据库与缓存无协议双写；只看命中率；缓存锁无租约/fencing；按玩家动态上下文无限膨胀缓存键。

## 验证方式

慢读旧值与并发更新竞态；失效消息丢失/重复/乱序；缓存全失效压测；热点键；stale-read rate；源站 QPS、回填并发、驱逐率、对象年龄和内存预算监控。

## 主要依据

- https://learn.microsoft.com/azure/architecture/patterns/cache-aside
- https://docs.aws.amazon.com/whitepapers/latest/database-caching-strategies-using-redis/caching-patterns.html
