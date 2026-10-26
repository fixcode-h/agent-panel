# UE Gameplay 框架与运行时设计

新功能要决定放在哪种载体、谁拥有状态、怎么加载资源、怎么同步时读这份。模块、Build.cs 和导出宏的规则见本技能的 SKILL.md 和 `cpp-code-style`。

## 适用场景

UE5 C++/Blueprint 项目的框架、Gameplay、资源、网络和数据架构。先确认 UE 版本、单机/联机、World 数量、目标平台及现有插件；官方语义与项目工程建议必须分开陈述。

## 决策问题

每个能力先回答：生命周期属于 Engine、GameInstance、World、LocalPlayer 还是 Actor？是否有空间身份？谁拥有网络权威？是否跨地图？数量规模？加载时机？设计师是否配置？

## 类型选择

| 需求                           | 优先载体                      |
| ------------------------------ | ----------------------------- |
| 跨地图会话服务                 | `UGameInstanceSubsystem`      |
| 每 World 服务                  | `UWorldSubsystem`             |
| 每本地玩家服务                 | `ULocalPlayerSubsystem`       |
| 服务端比赛规则                 | `AGameModeBase`/`AGameMode`   |
| 全体客户端可见比赛状态         | `AGameStateBase`/`AGameState` |
| 玩家跨 Pawn 的复制状态         | `APlayerState`                |
| 玩家意图、Possession、本地协调 | `APlayerController`           |
| 可控制空间实体                 | `APawn`/`ACharacter`          |
| 可复用 Actor 能力              | `UActorComponent`             |
| 非空间规则/运行期对象          | `UObject` 或普通 C++ 类型     |

Subsystem 是生命周期容器，不是把所有 Manager 改名后的垃圾桶。Actor 仅用于需要 World、Transform、碰撞、复制或关卡放置的对象。

## UObject 生命周期与所有权

- MUST 使用 UE 反射可见引用维护需要 GC 跟踪的 UObject 关系；非拥有观察使用适当弱引用。
- MUST NOT 用裸指针长期持有可能被 GC/World teardown 销毁的 UObject。
- Actor/Component 初始化逻辑必须匹配实际生命周期阶段，区分构造、注册、初始化、BeginPlay、EndPlay 与销毁。
- 委托、Timer、异步回调和任务必须在 Owner 结束时解绑/取消，并在回调时重新验证对象。
- GC 不替代资源释放、取消和业务清理。

## 资源与配置

- 硬引用用于必须随拥有者加载的小型核心资产；可选或重资源使用软引用与 Asset Manager/异步加载。
- DataTable/DataAsset 是作者数据，不应直接渗透所有运行期对象。
- 配置进入运行期前 SHOULD 形成不可变、校验后的投影；高频逻辑禁止临时跨表与同步加载。
- 策划要调的数值不写死在 C++ / Lua 里：做成 `UPROPERTY(EditDefaultsOnly)`、`UDeveloperSettings`（`Config=Game`）、DataTable / DataAsset，代码按名字读取；资产路径用软引用在一处配置，不在代码里散落 `/Game/...` 字符串（通用规则见 `coding-standards` 的 `configuration.md`）。
- Primary Asset 规则、Bundle、Cook 和 Chunk 必须以目标平台实测。

## 网络边界

- 服务器权威状态在服务端修改；复制同步状态，RPC 表达意图或瞬时命令。
- GameMode 不存在于普通客户端；全体可见状态放 GameState，玩家可见身份状态放 PlayerState。
- MUST 区分 Owner-only、relevancy、可靠/不可靠 RPC 与复制频率；可靠 RPC 不是“更好”的默认选项。
- 客户端输入必须校验；预测仅用于体验，最终裁决仍归权威端。
- 大规模复制前先 profile relevancy、频率和带宽，再评估 Iris/Replication Graph 等机制。

## GAS、Mass 与对象池

- GAS 适合属性、效果、能力授权、预测和复制需求明显的复杂玩法；简单交互不应为“可扩展”强上 GAS。
- Mass 适合大量同构实体和数据导向批处理；独特 Actor 行为或低数量对象不应机械迁移。
- 对象池只在 Spawn/Destroy 或分配已被 profile 证明是瓶颈时使用；必须定义完整重置、网络和生命周期语义。

## 性能约束

- 默认避免无条件 Tick；优先事件、Timer、条件 Tick 和批处理。
- MUST 为 Game Thread、Render Thread、GPU、内存、加载和网络建立平台预算。
- 异步任务不得访问非线程安全 UObject 状态；回主线程提交前检查 World/Owner 生命周期。

## 存档与演进

保存稳定身份、动态状态和 schema 版本，不保存 UObject 地址、缓存槽或临时句柄。定义版本迁移、缺失资产、旧配置和部分损坏策略，并在真实旧存档上回放。

## 反模式

God GameInstance；客户端读取 GameMode；所有状态放 Character；Actor 充当纯服务；硬引用整条资产链；Tick 轮询一切；RPC 当事件总线；DataTable 行指针长期存活；异步回调捕获已销毁 UObject；滥用 GAS/Mass/对象池。

## 验证方式

多人 PIE/专服测试；网络模拟与带宽 profile；Unreal Insights；Reference Viewer/Size Map；Cook 审计；Map teardown/Travel/PIE 多 World 生命周期测试；Automation/Functional/Gauntlet；旧存档迁移；模块依赖和 Public API 检查。

## 主要依据

- https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine
- https://dev.epicgames.com/documentation/en-us/unreal-engine/programming-subsystems-in-unreal-engine
- https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-actor-lifecycle
- https://dev.epicgames.com/documentation/en-us/unreal-engine/asset-management-in-unreal-engine
- https://dev.epicgames.com/documentation/en-us/unreal-engine/networking-overview-for-unreal-engine
- https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-ability-system-for-unreal-engine
- https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-entity-in-unreal-engine
