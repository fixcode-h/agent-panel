# C#/.NET 架构

## 适用场景

C# 类库、Console、Worker、桌面、ASP.NET Core 与 EF Core 项目。先读取 `TargetFramework`、SDK、`LangVersion`、宿主类型及框架版本；Web/EF 规则不得泛化为所有 C# 项目。

## 项目与程序集边界

Solution 是组织入口，不是运行时边界。仅在需要独立依赖方向、目标框架、发布、加载或可见性时拆 Project/Assembly。

- MUST 让核心项目不引用 UI、Web、EF Core 或具体基础设施。
- MUST NOT 创建无所有权的 `Common/Shared/Utilities`。
- SHOULD 使用 `internal`、项目引用和架构测试保护边界。
- 不为每个 namespace 或层机械创建项目。

## 依赖注入与配置

仅使用 Generic Host 时应用其 DI/Options 规则。

- Singleton 不得捕获 Scoped 服务或请求状态；Transient/Scoped 的选择基于所有权和资源生命周期。
- 服务注册集中于组合根；业务对象不得调用 Service Locator。
- Options 在启动期验证；需动态配置时明确 snapshot/monitor 语义和失败回退。
- `DbContext` 通常代表短生命周期 Unit of Work，非线程安全，不跨并发任务共享。

## 异步与并发

- I/O 链路保持 async，禁止以 `.Result`/`.Wait()` 阻塞异步任务。
- `CancellationToken` 从边界传播到 I/O、锁和后台工作；取消不等于回滚副作用。
- 普通异步 API 默认 `Task`；仅在高频且同步完成比例经测量证明时考虑 `ValueTask`。
- `IAsyncEnumerable<T>` 用于流式结果时必须定义取消、异常、背压和资源释放。
- BackgroundService 必须有有界队列、优雅关闭、错误策略和作用域创建规则。
- 并发集合不自动保证多步骤业务不变量原子性。

## 资源与内存

- `IDisposable/IAsyncDisposable` 表达确定性资源所有权；创建者负责释放，DI 容器创建的服务由容器释放。
- 不依赖 Finalizer 完成关键清理。
- `Span<T>`/`Memory<T>`、池化和无分配设计仅用于 profile 证明的热路径；不得让池化缓冲逃逸或重复归还。
- 大对象、装箱、闭包、LINQ 分配等优化必须通过 dotnet-counters/trace/gcdump 或 BenchmarkDotNet 证明。

## 类型与契约

- 启用 Nullable Reference Types，并把边界输入验证与内部空值不变量分开。
- 领域模型、持久化模型和外部 DTO 在生命周期或语义不同时分离。
- 异常用于异常失败；可预期业务拒绝可用显式结果。不要建立全局“所有方法都 Result”教条。
- Public API 变更按兼容矩阵评估；序列化类型不是随意重构的内部类。

## ASP.NET Core 专项

仅 Web 项目适用：Middleware 处理跨请求管道关注点；Filter 用于 MVC/endpoint 范围；业务规则留在应用/领域层。不得把 `HttpContext` 传入核心业务。认证不等于授权；每次请求校验对象和租户。

## EF Core 专项

- 事务围绕业务不变量；数据库约束是最后防线。
- 查询默认只投影需要字段；读路径按需 `AsNoTracking`，避免隐式 N+1。
- 乐观并发冲突必须定义重试、合并或拒绝语义。
- Migration 使用 Expand-Migrate-Contract；生产变更需审查 SQL、锁和回滚，而非应用启动时盲目迁移。
- Repository 仅在隔离领域持久化语义时引入，不机械包装全部 DbSet。

## 反射与生成

反射适合低频发现与元数据场景；AOT、启动和高频路径应评估 Source Generator 或显式注册。生成代码要有确定输入、可复现输出和清晰人工扩展边界。

## 可观测性

使用 `ILogger` 结构化日志和 OpenTelemetry Activity/Metrics；禁止敏感数据与高基数指标。

## 反模式

所有类都接口化；静态 Service Locator；Singleton 持有 DbContext；async void（事件处理器除外）；无界 Channel；同步阻塞异步；把 Web DTO/EF Entity 当领域模型；为微优化滥用 Span/池化；应用启动自动执行不可逆生产迁移。

## 模块运行时接口测试模板

### 定位与运行环境

采用轻量、表驱动的模块接口测试：构造固定输入，通过真实公开接口执行操作，再验证输出、状态或副作用。测试不复制业务实现，不通过反射或私有方法绕过公开入口，不绑定具体项目、宿主或测试库。

- 测试放入项目既有测试项目/目录，不在生产启动时自动执行。复用现有 xUnit、NUnit 或 MSTest；测试运行器必须发现每条数据用例，不能只写一个打印日志的工具。
- 纯逻辑测试可直接构造对象；运行时集成测试必须使用真实模块与所需依赖，并声明宿主、配置、资源、业务状态和初始化条件。缺少环境记为不可执行，不能当作通过。
- 通过构造函数或测试 Fixture 获取模块。使用 DI 的项目由测试组合根建立 Host/Scope；不得把 Service Locator 引入业务对象。无 Host 的项目不强制新增 Generic Host。
- 明确验证边界：直接调用应用服务不能证明 HTTP 路由、中间件、序列化或真实网络链路正确；涉及这些边界时从对应真实入口增加集成测试。WebApplicationFactory 仅用于适用的 ASP.NET Core 项目。

### 固定结构

| 成员 | 职责 |
| --- | --- |
| `ModuleInterfaceTests` | 模块接口测试集合，名称沿用项目规范 |
| `TestCases` / 数据源 | 固定、有序、具名的输入和预期结果，每条数据可独立发现和执行 |
| `CreateInput` / Builder | 每次构造独立、强类型输入，避免可变 DTO 被前一次执行污染 |
| `ExecuteAsync(Module, Input, CancellationToken)` | 映射参数并调用真实公开接口，不实现业务算法 |
| `Verify` / 框架断言 | 核对返回契约、最终状态及预期副作用；断言失败必须使测试失败 |
| Fixture | 准备并恢复状态，管理宿主、Scope、连接、订阅和后台任务 |
| `RunAsync(Name, Index, CancellationToken)` | 可选手动调用入口，使用同一用例定义；不替代自动测试发现与断言 |

优先使用已有测试框架的参数化能力，不为每个模块创建通用 Runner 基类。需要自定义用例数据结构时保持强类型，避免 `Dictionary<string, object>`、`dynamic` 和任意方法名反射调用。

以下是异步接口用例的通用结构示意，不是完整测试框架：

```csharp
public sealed class InterfaceTestCase<TModule, TInput, TResult>
{
    public string Name { get; set; } = string.Empty;
    public Func<TInput> CreateInput { get; set; } = default!;
    public Func<TModule, TInput, CancellationToken, Task<TResult>> ExecuteAsync { get; set; } = default!;
    public Action<TModule, TInput, TResult> Verify { get; set; } = default!;

    public async Task ExecuteAndVerifyAsync(TModule module, CancellationToken cancellationToken)
    {
        TInput input = CreateInput();
        TResult result = await ExecuteAsync(module, input, cancellationToken);
        Verify(module, input, result);
    }
}
```

示例需要项目已有的 `System`、`System.Threading`、`System.Threading.Tasks` 引用，且按实际 `LangVersion` 和 nullable 策略适配。初始化用例时必须提供所有委托，`Verify` 使用项目测试框架断言，禁止空实现。该类型仅在已有数据源无法表达需求时按需采用；不因示例强制引入新抽象。

同步接口直接使用同步参数化测试，不用 `Task.Run` 包装；无返回值接口用 `Action`/`Func<..., Task>` 表达并验证最终状态，不为适配结构制造假 boolean。异步查询或状态验证必须被完整 await，不能塞入 `Action` 产生 `async void`。

### 数据与执行协议

1. 为每条用例声明接口、固定输入、预期结果、前置状态、运行环境及清理方式。输入可依据已确认的数据表、配置和资源构造，但执行期间不得随机从生产数据挑样本。
2. 每条自动用例独立创建 Fixture/输入并按固定数据执行；不得依赖测试执行顺序、静态轮换计数或另一个用例先改变状态。多步流程在单个流程用例中明确编排。
3. 从公开入口调用真实模块。外部消息可构造符合实际协议的 DTO/结构体传入公开处理入口；这样只验证消息消费链，不证明传输、鉴权或协议序列化正确。
4. 先核对接口返回契约，再核对可观察业务结果。显式拒绝结果、异常和取消都按真实契约断言，不能统一以 `result == true` 或“未抛异常”为通过标准。
5. 完成或失败后释放测试拥有的资源、取消并等待后台任务、解绑事件、恢复临时配置与数据。使用 `using`、`await using` 或框架 Fixture/finally 协议；不要释放借用模块或容器仍拥有的对象。清理异常不得掩盖原始失败。

手动 `RunAsync` 可按名称和明确索引选择用例；若提供轮换模式，计数归当前测试实例且支持复位，并记录所选索引。自动回归不得依赖手动历史。涉及数据库时使用隔离数据/专用环境和明确清理策略；EF InMemory 不能替代真实数据库约束、事务和查询语义测试，不使用生产库验证破坏性操作。

### 异步完成、调用链与结果证据

- 返回请求已受理不等于业务已完成。异步流程必须等待真实事件、回调或有界状态条件并断言最终结果，禁止用固定 `Task.Delay` 或日志替代完成验证。
- 全链路传递 `CancellationToken`，区分预期取消与测试超时。超时应失败，并终止/等待测试启动的工作；仅停止等待不能视为后台任务已清理。禁止 `.Result`、`.Wait()` 和 `async void`。
- 不捕获异常后只记日志并返回成功；预期异常由测试框架断言，意外异常保留调用栈并使测试失败。
- 按真实接口契约覆盖合法输入、非法/缺失输入、重复调用、预期拒绝及必要的异步、取消、生命周期边界，不为不存在的业务行为增设测试。
- 报告包含模块、用例名、数据索引、入口、运行环境、预期/实际结果和失败层；日志复用项目现有接口，使用结构化字段且不输出敏感数据。Lua 的字符串格式不自动套用到 C#。
- 接口调用探针明确记录“仅调用/受理已验证”；只有断言通过才能报告测试通过。mock 单元测试、运行时集成测试和端到端测试的证据分别记录，不互相替代；无法执行的环境写明原因和待验证范围。
- 测试命令使用实际测试项目、框架、目标平台及宿主入口；普通 .NET 项目可使用 `dotnet test <测试项目> --filter <用例过滤条件>`，不能把该命令强制套到所有 C# 宿主。已发现问题关联模块 `bugs.md` 和对应 Bug 文档。

## 验证方式

项目依赖测试、nullable 警告门禁、异步取消测试、DI 生命周期验证、EF 并发/迁移测试、BenchmarkDotNet、dotnet diagnostics、WebApplicationFactory（仅 Web）及 Testcontainers/真实数据库集成测试。

## 主要依据

- https://learn.microsoft.com/dotnet/architecture/
- https://learn.microsoft.com/dotnet/core/extensions/dependency-injection-guidelines
- https://learn.microsoft.com/dotnet/csharp/asynchronous-programming/
- https://learn.microsoft.com/aspnet/core/fundamentals/
- https://learn.microsoft.com/ef/core/dbcontext-configuration/
- https://learn.microsoft.com/dotnet/core/diagnostics/
