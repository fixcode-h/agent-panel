# Lua 宿主集成

## 适用场景

Lua 与 C/C++、C#、Unity、Unreal Engine 或其他宿主交互。必须先读取 `lua-architecture.md`，再确认绑定框架、Lua 实现、宿主 GC/对象模型、线程和热更能力。

## 边界模型

明确每种对象的所有者：Lua 拥有、宿主拥有、共享句柄或借用引用。对每种跨界值定义创建、保活、失效、释放、线程、异常和重复释放语义。

## C API 与 userdata

- MUST 保持 Lua 栈平衡；每个 C 函数定义输入位置、返回数量和错误路径。
- Full userdata 适合有身份和生命周期的原生对象；light userdata 只是地址值，不提供所有权和 GC。
- `__gc` 可作安全网，但不应用于唯一的关键释放协议；提供显式 close/dispose。
- Registry 引用必须成对 `ref/unref`，并由明确 Owner 管理。
- C 长跳转/错误不得越过未准备的 C++ RAII 边界；按绑定框架规则转换错误。

## C# 与双 GC

Lua GC 与 .NET GC 不知道对方完整可达图。代理、Delegate、闭包和注册表引用可能形成跨 GC 环：

- 事件订阅必须显式解绑；
- 长期回调不得无意捕获大型对象图；
- P/Invoke/原生句柄遵循 SafeHandle/IDisposable 语义；
- AOT/IL2CPP 下反射、泛型和代码生成能力以平台实测；
- 不把 C# 线程任意带入非线程安全 Lua state。

## 游戏宿主与 UObject/Unity Object

宿主对象失效不等于 Lua 代理立即为 nil。每次跨帧、异步、Timer 或回调使用前按绑定框架验证有效性。World/Scene teardown 时批量取消任务、解绑事件并断开宿主引用。

UE、Unity、xLua、UnLua 的 API 和生命周期不同：不得把 Unity fake-null、UE UObject GC、LuaJIT FFI 或某个绑定框架热更能力写成通用 Lua 规则。具体项目必须读取所用框架版本的官方文档和现有封装。

## 调用与数据边界

- 高频循环减少细粒度跨 VM 调用；优先批量数据、运行时投影或宿主侧热路径。
- 明确字符串编码、数值范围、nil/null、集合复制/视图和异常转换。
- 外部 API DTO 与 Lua 内部 table 在语义或版本不同时映射，不直接泄漏宿主内部对象。
- 沙箱不是删除几个全局函数；不可信脚本需要能力白名单、资源配额、模块加载限制和宿主 API 最小权限。

## 热重载

热更必须跨越 Lua 模块、宿主注册、userdata 类型、回调和正在运行任务统一设计。宿主 ABI、字段布局或绑定签名变化通常不能靠 Lua 表打补丁安全解决。定义可热更范围与必须重启范围。

## 反模式

借用指针被 Lua 长期保存；双重释放；Delegate 永不解绑；主线程对象从后台线程访问；每帧逐对象跨 VM；宿主异常被吞；脚本可访问全部文件/网络/反射能力；热更后旧 userdata 调新 ABI。

## 验证方式

栈守恒断言；ASan/原生泄漏工具；.NET 内存分析；Scene/World teardown；重复注册/解绑；宿主先销毁与 Lua 先 GC 的双向矩阵；后台线程误用测试；跨界批量性能基准；热更兼容矩阵；沙箱逃逸和资源耗尽测试。

## 主要依据

- https://www.lua.org/manual/5.4/manual.html#4
- https://luajit.org/ext_ffi.html
- https://learn.microsoft.com/dotnet/standard/native-interop/best-practices
- https://github.com/Tencent/xLua
- https://github.com/Tencent/UnLua
- https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-object-handling-in-unreal-engine
