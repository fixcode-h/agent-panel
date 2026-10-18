# 运行时数据投影与配置

## 适用场景

表格驱动、游戏配置、规则配置、运行期对象初始化、物化读模型和热更新。

## 决策问题

把数据分为：原始配置、规范化配置、不可变运行时投影、实例动态状态、运行期求值规则、低频扩展。判断依据是正确性、访问频率、上下文依赖、成本和失效语义，而非字段多少。

## 候选方案与取舍

- 全量编译常驻：条目有限、投影小、启动预算允许。
- 按需急切投影：对象进入 Ready 前解析必需/高频字段，并按版本共享。
- 延迟扩展：低频、可独立失败、可异步的数据。
- 编译规则 + 运行时上下文：结果依赖玩家、时间或环境时，不缓存错误的最终值。

推荐流：`Raw Snapshot -> Canonical Model -> Runtime Projection -> Runtime Instance`。

## 强制约束

- MUST 在对象 Ready 前解析并校验全部初始化不变量。
- MUST 让领域对象依赖投影或版本句柄，不直接依赖 Raw Row/全局查表器。
- MUST 分离共享不可变定义与实例可变状态。
- MUST 为快照和投影携带 generation/version，并原子发布。
- MUST 在同一业务事务或批次中固定同一快照。
- MUST NOT 在消费点因缺字段临时查表。
- SHOULD 为列表加载提供去重、批量解析与有界并发。

## 反模式

复制整行表到每个实例；高频路径跨表查找；配置原地逐字段更新；缓存玩家上下文相关最终结果；低频资源被默认强引用；半初始化对象可被外部观察。

## 验证方式

扫描业务层直接查表；相同键共享性测试；配置切换并发测试；批量加载 N+1 检测；旧/新 generation 混读测试；投影重建与内容指纹比对；初始化失败原子性测试。

## 主要依据

- https://learn.microsoft.com/azure/architecture/patterns/materialized-view
- https://martinfowler.com/bliki/CQRS.html
- https://docs.aws.amazon.com/appconfig/latest/userguide/what-is-appconfig.html
