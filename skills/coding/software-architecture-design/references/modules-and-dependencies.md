# 模块与依赖

## 适用场景

模块拆分、公共库治理、单体服务化、跨模块调用和循环依赖治理。

## 决策问题

模块应围绕业务能力、变化原因、数据所有权与团队责任形成高内聚边界。先定义职责与非职责，再定义公开入口；内部实现默认不可见。

## 候选方案与取舍

- 进程内直接调用：低延迟、强类型，适合共同生命周期。
- 端口与适配器：隔离外部技术变化，但增加映射成本。
- 事件：适合事实广播和异步反应，不适合隐藏必须同步完成的命令。
- 独立服务：获得部署和隔离能力，同时承担网络、兼容、观测与一致性成本。

## 强制约束

- MUST 为每个模块指定所有者、公开 API、私有实现和数据写入权。
- MUST 让源码依赖指向稳定业务策略；核心不得依赖 UI、ORM、云 SDK 等细节。
- MUST NOT 跨模块访问内部类或直接修改他方数据。
- MUST NOT 建立无所有权的 `Common`、`Shared`、`Utils` 垃圾桶。
- SHOULD 仅在真实边界或变化方向处引入接口，不做一类一接口。

## 反模式

按 Controller/Service/Repository 横向分割全部业务；循环依赖靠共享模块掩盖；事件承载同步查询；远程 CRUD 服务；模块只能共同修改和发布却被拆成网络服务。

## 验证方式

依赖图、循环检测、禁止依赖测试、模块 API 测试、跨模块数据库访问扫描。每条规则放入 CI，并准备一个故意违规样例证明测试会失败。

## 主要依据

- https://martinfowler.com/bliki/BoundedContext.html
- https://learn.microsoft.com/en-us/azure/architecture/microservices/model/domain-analysis
- https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
