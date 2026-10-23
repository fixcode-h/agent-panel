---
name: ue-project-structure
description: Unreal Engine 项目的结构规范与常见坑：.uproject / .uplugin 与模块划分、Build.cs / Target.cs 依赖、Public / Private 与导出宏、UHT 反射、PIE 与 AutomationTest / FunctionalTest、Cook 与打包、资产命名和引用规则、C++ / Blueprint / Lua 分工。在 UE 项目里确定模块边界、加依赖、碰反射和序列化、跑测试、准备 Cook 或排查构建问题时使用。
user-invocable: true
---

# UE 项目结构

C++ 代码风格见 `cpp-code-style`，多 Agent 并行时的资源冲突见 `ue-multi-agent-coordination`，Lua 见 `lua-code-style`。这里讲项目怎么组织、怎么编译、怎么验证。

## 先确认的事实

- `.uproject` 的位置和 `EngineAssociation`（引擎版本、源码引擎还是启动器引擎）。
- 模块清单：`Source/<Module>/` 下有没有 `*.Build.cs`，模块类型（Runtime / Editor / Developer / Program）。
- Target：`Source/*.Target.cs` 有几种（Game、Editor、Client、Server），编译要用哪一个。
- 插件：`Plugins/` 下自己写的插件，`.uplugin` 里的模块和加载阶段。
- 资产根：`Content/`、插件里的内容、`Config/` 的关键项（`DefaultEngine.ini`、`DefaultGame.ini`）。

## 怎么找代码

UE 工程根目录下有几十万文件，在根目录全仓 grep 会把 `Saved/`、`Intermediate/`、`Binaries/` 里的产物一起扫出来，几分钟才停。搜索前先定位模块：按项目文档（模块地图、模块 README）或 `Source/<模块>/` 的目录名缩小范围，再在模块目录里搜；报错指到具体文件时直接读那个文件。通用的收敛顺序（先文档、再最小目录、已知文件直接读）见 `project-structure`。

必须排除的目录（写进项目设置的「搜索时跳过的目录」，提示词会带出来）：

| 目录 | 里面是什么 |
| --- | --- |
| `Binaries/` | 编译出的 dll / pdb |
| `Intermediate/` | UBT / UHT 生成的中间文件（含 `*.generated.h`） |
| `Saved/` | 日志、自动截图、Cook 与打包产物 |
| `DerivedDataCache/` | DDC 缓存 |
| `Build/`、`.vs/` | 平台打包产物、Visual Studio 缓存 |
| `Plugins/*/Intermediate`、`Plugins/*/Binaries` | 插件各自的产物 |

`Content/` 里的 `.uasset` / `.umap` 是二进制：只能按文件名找路径，**不要 grep 内容**——搜不到可读文本，还会拖慢整个搜索。要看资产引用了谁，用编辑器的 Reference Viewer（右键资产 → Reference Viewer），不要靠 grep。

可照抄的命令：

```bash
# 只在某个游戏模块里搜 C++
rg -n -g '!Binaries' -g '!Intermediate' -g '!Saved' -g '!DerivedDataCache' 'FMyClass' Source/MyGame/

# 找资产路径（按名字，不搜内容）
rg --files Content -g '*.uasset' -g '*.umap' | rg 'BP_Player'

# 只在被跟踪的源文件里搜（Git 仓库；P4 / 无版本控制时用下面的 rg）
git grep -n 'FMyClass' -- 'Source/**/*.h' 'Source/**/*.cpp'

# 看未跟踪的源文件：从 Source/ 子目录起，并剪掉中间产物
find Source -maxdepth 4 -type f \( -name '*.h' -o -name '*.cpp' \) -print
```

`find . -name ...` 在 UE 工程根目录会遍历 `Saved/`、`Intermediate/`、`DDC`，跑几分钟：要么从 `Source/` 这样的子目录起，要么带 `-maxdepth` 和 `-path '*/Intermediate' -prune`。

## 模块和依赖

- **依赖方向单向**：底层模块不引用上层。公共能力抽到底层模块，不要用 `Type = "Editor"` 的反向依赖绕过。
- `Build.cs` 的 `PublicDependencyModuleNames` 和 `PrivateDependencyModuleNames` 分开：头文件里 `#include` 了谁的公开头，谁放 Public；只在 cpp 里用的放 Private。
- 头文件里出现其他模块的类型时，优先前向声明 + 指针 / 引用，cpp 里再 include。
- `Public/` 和 `Private/` 的边界就是模块的可见边界：`Public/` 里的头会被其他模块 include，改动它的兼容性成本最高。
- 导出宏：`Public/` 下暴露给其他模块的类 / 函数带模块的 `MYMODULE_API`；只在模块内部用的不加。
- 新增模块时三件套一起改：`.Build.cs`、`.uproject`（或 `.uplugin`）的 `Modules` 列表、Target 的 `ExtraModuleNames`（如果走默认打包）。

## UHT 与反射

- 反射宏（`UCLASS` / `USTRUCT` / `UENUM` / `UFUNCTION` / `UPROPERTY`）只写在 UHT 能解析到的位置，且必须在 `GENERATED_BODY()` 之上。
- 反射类型要能被垃圾回收追踪：`UPROPERTY()` 的指针成员才安全；裸指针成员不管生命周期就会悬空。
- `UFUNCTION` 的参数类型必须是反射系统认识的；容器用 `TArray` / `TMap` / `TSet`，不要用 STL。
- 改了反射结构（加字段、改类型、改枚举值）要考虑序列化和 Blueprint 兼容：删字段会让已有资产丢数据，改枚举值会改变已有资产的语义。
- 接口（`UINTERFACE`）要实现 `_Implementation`；编辑器模块的类不要出现在 Runtime 模块的反射里。

## 编译

- 用项目自己的 `Build.bat` / `RunUAT.bat` 或平台脚本，参数里带 `-Project=<.uproject>`、`-NoUBTMakefiles`、`-WaitMutex`。
- 同一时间只编译一次：UBT 的中间产物和 DDC 会互相覆盖。
- 编译不过先看第一条错误，后面的经常是连带错误。UHT 的错误通常指到反射声明那一行。
- Live Coding / Hot Reload 只适合小改动；改了反射结构必须完整编译并重启编辑器。

## 测试

- **AutomationTest**（`IMPLEMENT_SIMPLE_AUTOMATION_TEST`）：纯逻辑、无编辑器依赖的优先用它，命令行能跑，适合 CI。
- **FunctionalTest**：需要世界、Actor、玩家输入的场景测试；在编辑器或 `-game` 模式下跑。
- 命令行跑测试用 `-ExecCmds="Automation RunTests <Filter>;Quit"`，加 `-unattended -nopause -nullrhi`。
- 需要编辑器界面、PIE 交互、真机或特定渲染的验证登记为延期验证，写明步骤。
- 测试代码放在对应模块的 `Private/Tests/` 下，用 `WITH_DEV_AUTOMATION_TESTS` 包住。

## 资产规则

- 命名：`BP_`、`M_` / `MI_`、`T_`、`SM_`、`SK_`、`ABP_`、`DA_`、`DT_`、`WBP_`；同一类资产保持同一套前缀。
- 引用：能不硬引用就不硬引用。运行时按需加载用软引用（`TSoftObjectPtr` / `FSoftObjectPath`），路径集中配置。
- 大量一次性资产会拖慢 Cook 和加载：确认插件里的示例内容、测试资产没有被打进包。
- 改动资产的目录或改名要在编辑器里做（走重定向器），不要直接移动文件。

## Cook 与打包

- Cook 只打进被引用到的资产：`DefaultGame.ini` 里 `DirectoriesToAlwaysCook` 用来兜底动态加载的路径。
- Cook 失败最常见的原因：资产引用丢失、编辑器模块被 Runtime 代码引用、插件没启用、平台 SDK 缺失。
- 打包前在干净的环境里编译一次，避免依赖本机的中间产物。

## 常见坑

- `Public/` 里的头文件 include 了 `Private/` 的文件：本机能编，别的模块编译失败。
- 反射类型里用了 `int` 而不是 `int32`，或者在 `USTRUCT` 里用了不支持的类型。
- 在构造函数里做需要世界或游戏实例的事；它会在 CDO 上执行。
- 多播委托、Lambda 捕获 UObject 裸指针导致悬空。
- 编辑器和打包版本行为不一样：只在编辑器里验证过就认为通过。
- 改了配置（`Config/*.ini`）但没确认哪一级的配置生效（Base / Default / Saved）。
