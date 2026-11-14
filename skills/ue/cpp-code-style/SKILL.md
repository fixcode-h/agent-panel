---
name: cpp-code-style
description: 编写或修改 C++ / Unreal Engine C++ 代码时使用；规定换行（非必要不换行、不按字数或列宽换行，只在代码块、初始化列表、多行初始化、lambda 体、多行字符串处换行，日志调用写一行）、声明与实现顺序、Tab 缩进与列对齐、初始化列表、if/switch 格式、命名与常用写法、校验与防御（什么时候判空、校验，避免过度防御）、避开静态分析告警的写法（循环里的 lambda 谓词、判空后解引用）、注释、日志（格式 `[模块名称] 类名=>函数名  具体日志内容`，避免高频日志），以及 UE 反射宏和模块导出宏的用法。只约束新写的代码；不用于 Lua 或 Build.cs。
user-invocable: true
---

# C++ 代码格式（含 Unreal Engine）

## 使用边界

- **只约束新写的代码**：新文件完整采用；已有文件里只管新增的声明、变量、函数和代码块，不顺手重排、改名、补注释或格式化旧代码。用户明确要求整理旧代码时，按指定范围处理。
- 动手前先看目标模块相邻的 `.h` / `.cpp`；所在文件已有一套一致的写法和本技能冲突时，局部跟着文件走，不为套模板制造无关 diff。
- 只管格式与组织，不管架构、对象所有权和资源加载策略。UE 反射宏、generated 头和初始化顺序始终服从 UHT 与编译器要求。
- 普通 C++ 忽略下文标「仅 UE」的条款。

## 换行

**非必要不换行，换不换行只看结构，不看字数。** 一条语句写一行：`if` / `while` 的条件、`return` 后的表达式、赋值右边、函数声明与调用的参数列表、反射宏参数，都写在同一行，不管有多少个 `&&` / `||`、这一行有多长。不要自己设一个 80 或 120 列的上限去折行，也不要因为「这行看着长」「字符串参数长」就把参数挪到下一行。

**只有下面几种情况换行：**

1. 代码块本身：函数体、`if` / `for` / `while` / `switch` 的块体，大括号按本技能的格式分行，`case` 各占一行。
2. 构造函数的初始化列表：按下文「命名与写法」里初始化列表的格式分行。
3. 多行的大括号初始化：数组、结构体、`TMap` 等初始化项较多或每项本身较长时，一项一行；两三项的简单初始化照样写一行。
4. 参数里有 lambda：lambda 的头写在调用那一行，函数体照常分行，`});` 收尾；其余参数不拆。
5. 多行原始字符串（`R"(...)"`）：内容本来就是多行的。
6. 项目格式化配置明确规定了列宽（如 `.clang-format` 的 `ColumnLimit` 大于 0、`.editorconfig` 的 `max_line_length`）：按配置来；没有配置就不折行。

除此之外都不换行。**日志调用一律写一行**：`UE_LOG(` 之后不换行，类别、级别、`TEXT( ... )` 和格式化参数跟在同一行，不管多长；`ensureMsgf`、`checkf` 同样。

```cpp
// 错：按字数把日志文本折到下一行
UE_LOG( LogExampleHUD, Warning,
	TEXT( "[HUD] AExampleHUD=>DrawHUD  跳过绘制，HudStyle 未配置" ) );

// 对：日志调用写一行
UE_LOG( LogExampleHUD, Warning, TEXT( "[HUD] AExampleHUD=>DrawHUD  跳过绘制，HudStyle 未配置" ) );

// 错：条件被拆成续行
if ( CurrentState == EZoneState::EntryPreparing || CurrentState == EZoneState::Underground
	|| CurrentState == EZoneState::ExitPreparing )

// 对：整条写在一行
if ( CurrentState == EZoneState::EntryPreparing || CurrentState == EZoneState::Underground || CurrentState == EZoneState::ExitPreparing )
```

- 条件真的复杂到一行看不懂（多层括号混着 `&&` / `||`），把其中一部分提成命名清楚的局部变量或函数，不要拆成续行；几个同类比较连起来的照样写一行。
- 原来就折了行的旧代码不顺手合并，除非就是这次要改的那一句。

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

## 校验与防御：不过度

先问一句：**这个值会不会真的为空、越界或非法？** 只有答案是「会」时才写检查。

**不加检查：**

- 调用方都在项目里、契约明确的参数。参数不允许为空就用引用（`const T&` / `T&`）表达，函数里不再判空。
- 刚创建、刚检查过的值；上一层已经判过的，下一层不再判。
- 生命周期有保证的成员：构造或 `BeginPlay` 里一定赋值、且被 `UPROPERTY` 持有的对象，后续方法直接用，不在每个函数开头 `IsValid` 一遍。

**需要判空：**

- 本来就可能失败的调用：`Cast< T >`、`TMap::Find`、`FindComponentByClass`、`GetOwner` / `GetWorld`（在可能还没进关卡或已离开时）、资源加载、`TWeakObjectPtr::Get()`。
- 异步回调、定时器、委托里用到的对象：回调到来时对象可能已销毁，判 `IsValid` 一次。
- 可选参数（指针默认 `nullptr`）。

**需要校验取值：**

- 外部数据：网络 RPC（服务器必须校验客户端发来的参数）、存档、配置表、玩家输入。
- 数组下标来自外部或计算结果时用 `IsValidIndex`。

**检查失败时：**

- 不能用 `if ( Ptr ) { ... }` 把本不该发生的空悄悄跳过。为空是正常情况就按正常流程处理；本不该出现的用 `ensure` / `ensureMsgf`（可恢复，会报出来）或 `check`（继续运行没有意义时），或 `UE_LOG` 打一条 Error。
- 一个值只在进入可信区域的那一处检查，不在调用链每层都检查一遍。

## 静态分析告警：写法上就避开

cppcheck、PVS 这类工具看不懂一些合法写法，会报误报或「形态问题」。新写的代码直接用工具能看懂的写法；修已有告警时**只改写法、不改行为**：控制流、返回值、日志和失败处理都保持原样，不靠加分支、改逻辑或屏蔽注释来消告警（确认是误报又改不了写法时，才按项目约定加屏蔽并写明原因）。

- **循环里不写带 `return` 的 lambda 谓词**（`unConditionalBreakinLoop`）：工具不认 lambda 边界，把谓词里的 `return` 当成「循环无条件跳出」。传给 `ContainsByPredicate` / `FindByPredicate` / `RemoveAll` / `std::find_if` 等的谓词，在循环里使用时提成具名谓词：把查找连同谓词包进循环外的文件级辅助函数或成员函数（或在循环外定义具名函数对象），循环里只调名字。

```cpp
// 错：循环体里的 lambda 带 return，被报「循环里无条件 break」
for ( const FItem& Item : Items )
{
	if ( Slots.ContainsByPredicate( [ &Item ]( const FSlot& Slot ) { return Slot.ItemId == Item.Id; } ) ) continue;
	AddSlot( Item );
}

// 对：谓词提成循环外的具名函数，循环里不出现 return
static bool HasSlotOfItem( const TArray< FSlot >& Slots, int32 ItemId )
{
	return Slots.ContainsByPredicate( [ ItemId ]( const FSlot& Slot ) { return Slot.ItemId == ItemId; } );
}

for ( const FItem& Item : Items )
{
	if ( HasSlotOfItem( Slots, Item.Id ) ) continue;
	AddSlot( Item );
}
```

- **判空后要解引用，就在判空处显式返回**（`nullpointer`）：先 `if ( !Ptr )` 只打日志或记错误、不返回，后面又直接 `*Ptr` / `Ptr->`，运行时靠别处（如后续统一的错误检查）兜底，工具和读者都看不出来。失败分支在判空的地方直接 `return`（或跳过本次循环），让「读失败就返回」写在明处。

```cpp
// 错：判空后没返回，靠后面 ReadErrors 兜底，工具报空指针解引用
if ( !ItemExcel ) ReadErrors.Add( TEXT( "ItemExcel" ) );
if ( ReadErrors.Num() > 0 ) return false;
ParseItems( *ItemExcel );

// 对：显式判空守卫，行为不变（原本也会因读失败返回）
if ( !ItemExcel )
{
	ReadErrors.Add( TEXT( "ItemExcel" ) );
	return false;
}
ParseItems( *ItemExcel );
```

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

1. 新写的条件、`return`、声明、调用和日志调用没有被拆成续行，换行只出现在「换行」一节列出的几种情况（项目格式化配置规定了列宽的除外）。
2. 头文件分组、类内顺序和可见性合理；Tab 缩进、组内列对齐、初始化列表顺序正确；命名、`const` 符合约定；没有过度防御：契约明确的参数和生命周期有保证的成员没有层层判空，检查失败没有悄悄跳过；新函数没有 `_` 前缀；`.cpp` 定义顺序对应声明。
3. 仅 UE：反射宏位置和 generated include 合法；没有整类导出，导出宏只加在确有跨模块需求的函数上。
4. 日志是 `[模块名称] 类名=>函数名  具体日志内容`，只打在必要路径、没有高频日志，没有级别前缀、没有新增包装器。
5. 循环里没有带 `return` 的 lambda 谓词；判空后要解引用的地方，判空分支显式返回；修静态分析告警只改了写法、没改行为。
6. 注释讲意图不复述代码；没动范围外的旧代码。UE 项目还要实际跑 UHT / UBT 和相关测试，格式检查不等于编译通过。
