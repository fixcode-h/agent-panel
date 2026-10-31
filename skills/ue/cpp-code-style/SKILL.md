---
name: cpp-code-style
description: 编写或修改 C++ / Unreal Engine C++ 代码时使用；规定换行（一条语句写一行，不按列宽折行）、声明与实现顺序、Tab 缩进与列对齐、初始化列表、if/switch 格式、命名与常用写法、注释、日志（格式 `[模块名称] 类名=>函数名  具体日志内容`，避免高频日志），以及 UE 反射宏和模块导出宏的用法。只约束新写的代码；不用于 Lua 或 Build.cs。
user-invocable: true
---

# C++ 代码格式（含 Unreal Engine）

## 使用边界

- **只约束新写的代码**：新文件完整采用；已有文件里只管新增的声明、变量、函数和代码块，不顺手重排、改名、补注释或格式化旧代码。用户明确要求整理旧代码时，按指定范围处理。
- 动手前先看目标模块相邻的 `.h` / `.cpp`；所在文件已有一套一致的写法和本技能冲突时，局部跟着文件走，不为套模板制造无关 diff。
- 只管格式与组织，不管架构、对象所有权和资源加载策略。UE 反射宏、generated 头和初始化顺序始终服从 UHT 与编译器要求。
- 普通 C++ 忽略下文标「仅 UE」的条款。

## 换行

**一条语句写一行，不按列宽换行。** `if` / `while` 的条件、`return` 后的表达式、赋值右边、函数声明与调用的参数列表、反射宏参数，都写在同一行，不管有多少个 `&&` / `||`、这一行有多长。不要自己设一个 80 或 120 列的上限去折行。

```cpp
// 错：条件被拆成续行
if ( CurrentState == EZoneState::EntryPreparing || CurrentState == EZoneState::Underground
	|| CurrentState == EZoneState::ExitPreparing )

// 对：整条写在一行
if ( CurrentState == EZoneState::EntryPreparing || CurrentState == EZoneState::Underground || CurrentState == EZoneState::ExitPreparing )
```

- 唯一例外：项目里有格式化配置明确规定了列宽（如 `.clang-format` 的 `ColumnLimit` 大于 0、`.editorconfig` 的 `max_line_length`），按配置来；没有配置就不折行。
- 条件真的复杂到一行看不懂（多层括号混着 `&&` / `||`），把其中一部分提成命名清楚的局部变量或函数，不要拆成续行；几个同类比较连起来的照样写一行。
- 大括号、初始化列表、`switch` 的 `case` 照常分行；这一条只管「一个表达式被拆到几行」。原来就折了行的旧代码不顺手合并。

## 头文件

1. 文件头用项目现有的版权注释（UE 项目可用 UE 默认文件头），不编造日期或版权；之后空一行写 `#pragma once`（项目用 include guard 就跟项目）。
2. include 按「本模块 → 依赖模块 → 标准库 / 平台」分组；能前置声明的就前置声明。仅 UE：`*.generated.h` 必须是最后一个 include。
3. 前置声明、类型别名、辅助类型各成一组，组间空一行。
4. 仅 UE：`UCLASS` / `USTRUCT` 单独一行，紧贴类型声明；`GENERATED_BODY()` 放在类型体第一行；`UPROPERTY` / `UFUNCTION` 单独一行，下一行写声明。
5. 类内按职责分组：类型别名 → 私有缓存 / 运行时数据 → 公开配置（UE 可用 `UPROPERTY`，按业务分组）→ 构造与清理 → protected 生命周期重载 → private 内部函数 → 对外接口（UE 可为 Blueprint 接口）。没有的组跳过；按需重复写 `public:` / `protected:` / `private:`，不为凑顺序放大可见性。
6. `.cpp` 里新增的定义按 `.h` 的声明次序排；文件级辅助函数放在类型实现之前；不为对齐顺序挪动旧实现。
7. 新增函数（包括私有函数）用正常名字，如 `ApplyCurve`，**不以 `_` 开头**；不为格式重命名已有 API。

## 命名与写法

- 名字用 PascalCase，所在文件已有约定就跟文件。仅 UE：类型前缀 `U`（UObject）、`A`（Actor）、`F`（结构体 / 普通类）、`E`（枚举）、`I`（接口）、`T`（模板）、`S`（Slate 控件），布尔变量加 `b` 前缀。
- 枚举用 `enum class`；仅 UE 反射枚举写 `UENUM()` + `enum class EFoo : uint8`。
- 空指针用 `nullptr`；普通指针判空写 `if ( !Ptr )`，仅 UE：UObject 判有效用 `IsValid( Obj )`。
- 仅 UE：UObject 成员指针用 `TObjectPtr<>` 并加 `UPROPERTY()`，否则会被 GC 回收；不长期持有的引用用 `TWeakObjectPtr<>`。
- 不改成员的函数加 `const`；只读的非基础类型参数用 `const T&`。
- `auto` 只在类型一眼能看出时用（迭代器、lambda、`Cast< T >` 的结果），其余写明类型。
- 提前 `return` 处理异常分支，少套层级。

## 缩进、对齐与空白

- 用 Tab 缩进，大括号独占一行；空行分隔大组。
- 一组紧凑的变量，类型、变量名、行尾注释用空格按列对齐；每组单独对齐，不按全文件最长的类型拉宽。各自带 `UPROPERTY` 的属性不强制跨组对齐。
- 连续的相关赋值可以对齐 `=`，单个赋值不补空格；不为对齐调整字段顺序。
- 初始化列表：`:` 单独一行，成员名和括号按列对齐，顺序与声明一致，只写需要显式初始化的成员。
- 括号内留空格：`if ( Condition )`、`Foo( Value )`、`TArray< FItem >`、`if ( !Object )`。

## `.cpp` 控制流

- 第一个 include 是对应的头文件，其余按项目 / 依赖 / UE 分组。
- 无副作用的单行 guard 可写成 `if ( !Object ) return;`；多语句分支用独占行的大括号，`else` 单独一行。
- `case` 与 `switch` 的大括号对齐，同逻辑的标签相邻；多语句或要声明局部变量的 `case` 用独立 `{ }`，`break` 放在块后同级；简单分支可写 `case X: return Y;`。

## 注释

- 头文件里类型和较大的成员区域可用 `///-----` 分隔线加简短组名；不显然的字段写明用途、单位或资源含义，可用行尾注释。不给每个字段机械地加重复注释。
- 接口、生命周期重载、有调用前提的声明写一句说明。
- `.cpp` 函数前不复制头文件里的描述，也不加 `//====`、`@brief` 横幅；只在有非显然约束、算法原因或生命周期注意点时写注释。

## 日志

格式不变：

```text
[模块名称] 类名=>函数名  具体日志内容
```

- 类 / 对象方法写「类名=>函数名」，静态或自由函数写「命名空间或模块名=>函数名」，不能只写函数名。函数标识和内容之间固定**两个**空格。
- 先确认日志所在的类和函数，不根据文件名或日志内容去猜。
- 沿用 `UE_LOG( 类别, 级别, ... )` 等已有接口：级别写在宏参数里，消息里不重复；不新增日志类别或包装器。
- **避免高频日志，只在必要路径加必要的日志**：必要路径指失败 / 异常分支、重要状态切换、关键流程的结果。Tick、每帧、循环体、频繁调用的函数里一律不打；不给每一步打「开始 / 结束」；成功的常规路径默认不打；排查用的临时日志改完删掉。一条日志写清一件事，只带定位需要的关键参数。
- 示例：`UE_LOG( LogExampleHUD, Warning, TEXT( "[HUD] AExampleHUD=>DrawHUD  跳过绘制，HudStyle 未配置" ) );`

## UE 模块导出（仅 UE）

- **默认不加 `模块名_API`**。只有确认其他模块有实际的原生 C++ 调用或链接需求时才加；不因声明在 `Public`、带反射宏、Blueprint 可见、被 Lua / UnLua 通过反射调用，或「以后可能复用」就导出。
- **不整类导出**：类声明上不写 `模块名_API`。需要跨模块使用的 UObject 类在 `UCLASS(...)` 里加 `MinimalAPI`，再只给其他模块确实要调用的函数单独加 `模块名_API`（如 `SPLEVELEDITOR_API void Execute();`）。普通 C++ 类、接口和非 `UCLASS` 类型不用 `MinimalAPI`，同样逐函数导出。
- 成员变量不加 `模块名_API`；其他模块要读，就加一个按需导出的访问函数，优先返回值或只读视图。
- 加导出前核对调用方模块、`Build.cs` 依赖、Public / Private 头文件边界和符号实现位置；证明不了有跨模块引用就不加。改完按项目要求跑 UHT、编译和调用方模块的链接，不只编定义方。不批量改任务范围外的已有导出。

## 示例

声明在 `.h`，定义在对应 `.cpp`；版权行只在项目已有实际版权文本时填。

```cpp
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "ExampleHUD.generated.h"

class UCurveFloat;

///-------------------------------------------------------------------------------------------------
/// HUD 显示数据
///-------------------------------------------------------------------------------------------------
USTRUCT( BlueprintType )
struct FExampleHudStyle
{
	GENERATED_BODY()

	// 字体缩放倍率
	UPROPERTY( EditAnywhere, BlueprintReadOnly, Category="HUD" )
	float FontScale = 1.f;

	// 透明度曲线
	UPROPERTY( EditAnywhere, BlueprintReadOnly, Category="HUD" )
	TObjectPtr< UCurveFloat > OpacityCurve = nullptr;
};

///-------------------------------------------------------------------------------------------------
/// class    AExampleHUD
///-------------------------------------------------------------------------------------------------
UCLASS()
class AExampleHUD : public AHUD
{
	GENERATED_BODY()

private:
	//-------------------------------------------------------------------------------------------------
	// Cache - Datas
	//-------------------------------------------------------------------------------------------------
	float ViewportScale; // 当前视口缩放
	bool  bCanDraw;      // 是否允许绘制

public:
	///-------------------------------------------------------------------------------------------------
	/// Attribute
	///-------------------------------------------------------------------------------------------------
	UPROPERTY( EditDefaultsOnly, BlueprintReadOnly, Category="HUD" )
	FExampleHudStyle HudStyle;

public:
	AExampleHUD();

	// 清理显示状态
	void Clear();

protected:
	// 开始显示时初始化运行时状态
	virtual void BeginPlay() override;

	// 离开关卡时清理运行时状态
	virtual void EndPlay( const EEndPlayReason::Type EndPlayReason ) override;

	virtual void DrawHUD() override;

private:
	bool CanDraw() const;
	void DrawItem( int32 ItemType );

public:
	// 更新绘制开关
	UFUNCTION( BlueprintCallable, Category="HUD" )
	void SetCanDraw( bool bEnabled );
};
```

```cpp
#include "ExampleHUD.h"

#include "Curves/CurveFloat.h"

AExampleHUD::AExampleHUD()
:
ViewportScale ( 1.f  ),
bCanDraw      ( true )
{
}

void AExampleHUD::Clear()
{
	bCanDraw = false;
}

void AExampleHUD::BeginPlay()
{
	Super::BeginPlay();
}

void AExampleHUD::EndPlay( const EEndPlayReason::Type EndPlayReason )
{
	Clear();
	Super::EndPlay( EndPlayReason );
}

void AExampleHUD::DrawHUD()
{
	Super::DrawHUD();
	if ( !CanDraw() ) return;

	DrawItem( 1 );
}

bool AExampleHUD::CanDraw() const
{
	return bCanDraw && HudStyle.FontScale > 0.f;
}

void AExampleHUD::DrawItem( int32 ItemType )
{
	switch ( ItemType )
	{
	case 1:
		{
			const float Scale = HudStyle.FontScale * ViewportScale;
			DrawText( TEXT( "HUD" ), FColor::White, 0.f, 0.f, nullptr, Scale );
		}
		break;
	default:
		UE_LOG( LogExampleHUD, Warning, TEXT( "[HUD] AExampleHUD=>DrawItem  未知类型 ItemType=%d" ), ItemType );
		return;
	}
}

void AExampleHUD::SetCanDraw( bool bEnabled )
{
	bCanDraw = bEnabled;
}
```

## 自检

1. 新写的条件、`return`、声明和调用没有被拆成续行（项目格式化配置规定了列宽的除外）。
2. 头文件分组、类内顺序和可见性合理；Tab 缩进、组内列对齐、初始化列表顺序正确；命名、`const`、判空符合约定；新函数没有 `_` 前缀；`.cpp` 定义顺序对应声明。
3. 仅 UE：反射宏位置和 generated include 合法；没有整类导出，导出宏只加在确有跨模块需求的函数上。
4. 日志是 `[模块名称] 类名=>函数名  具体日志内容`，只打在必要路径、没有高频日志，没有级别前缀、没有新增包装器。
5. 注释讲意图不复述代码；没动范围外的旧代码。UE 项目还要实际跑 UHT / UBT 和相关测试，格式检查不等于编译通过。
