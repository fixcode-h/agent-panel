---
name: cpp-code-style
description: 编写或修改普通 C++ 与 Unreal Engine C++ 的新增代码时使用；规范声明与实现顺序、注释、Tab 缩进、变量列对齐、初始化列表、if/switch/case 格式及日志的「类名=>函数名」定位，并在 UE 代码中约束反射宏。默认不重排已有代码，只有明确要求格式化时才整理存量代码；不用于 Lua 或 Build.cs。
user-invocable: true
---

# C++ 代码格式（含 Unreal Engine）

## 使用边界

编写普通 C++ 或 UE C++ 时，先读取目标模块相邻的 `.h`、`.cpp` 与项目既有约束；本技能提供基于 ProjectN `Source/ProjectN/UI/NkHUD.h`、`NkHUD.cpp` 提炼的格式模板。**默认仅约束新写的代码**：新增文件完整采用；在已有文件中仅对新增声明、变量、函数与代码块采用，不顺手重排、改名、补注释或格式化存量代码。只有用户明确要求“格式化/整理原有代码”时才按指定范围处理旧代码。与已有文件格式冲突时尽量局部兼容，不为套用模板产生无关 diff。

文件头采用项目现有默认版权注释；UE 项目可采用 UE 默认文件头，不复制 `NkHUD` 的 `@file/@brief/@date` 长横线文件头，也不写入虚构的日期或版权信息。普通 C++ 不需要 UE 反射宏、generated header 或 UObject 规则；下文相关条款和示例只在 UE 工程中适用。

这是一份**格式与组织**规则，不负责架构选择、对象所有权或资源加载策略；不照搬 `NkHUD` 中的 `AddToRoot`、构造函数访问 World、全局辅助函数、裸 UObject 指针或手工 `Clear` 行为。UE 反射宏、生成头及初始化顺序始终服从当前 UE/UHT 和编译器要求。

## 头文件布局与声明顺序

1. 按项目默认文件头写实际版权信息（如适用），空行后使用 `#pragma once`；已有项目若使用传统 include guard，则遵守项目既有要求。
2. include 按本模块/项目、依赖模块、标准库/平台头文件分组；能前置声明的类型先前置声明。UE 文件再按项目约定排列 UE 头，`*.generated.h` 必须是最后一个 include。
3. 前置声明、类型别名、辅助类型各自成组，组之间留空行。
4. 仅 UE：`USTRUCT`/`UCLASS` 反射宏单独一行，紧接类型声明；`GENERATED_BODY()` 位于类型体首部。`UPROPERTY`/`UFUNCTION` 宏单独一行，下一行写声明。
5. 类内按职责分组而非按类型字母排序：类型别名 → 私有缓存/运行时数据 → 公开配置（UE 类可用 `UPROPERTY`，按业务领域分组）→ 构造与清理接口 → protected 生命周期重载（如适用）→ private 内部函数 → 对外接口（UE 类可为 Blueprint 接口）。不是每个类都必须包含所有分组；根据实际访问控制重复使用 `public:` / `protected:` / `private:`，不要为符合顺序扩大成员可见性。
6. 辅助类型按数据分组后列出构造及行为函数；仅 UE 的 `USTRUCT` 在首部放 `GENERATED_BODY()`，按语义分组 `UPROPERTY`，再写构造及行为函数。
7. 函数声明、宏参数和参数列表尽量单行；确实过长时才按语义折行并保持续行可读，不拆开 UE 反射宏与对应声明的相邻关系。`.cpp` 中同一类型的新增定义尽量按 `.h` 声明次序排列；不要为匹配此顺序挪动旧实现。文件级辅助实现放在类型实现前。
8. 新增私有函数使用正常名称，如 `ApplyCurve`、`DrawDamageTexts`，**不要以 `_` 开头**；不把 `NkHUD` 旧的 `_ApplyCurve` 命名复制到新代码。不为格式要求重命名既有 API。
9. 仅 UE：模块导出宏（`模块名_API`）和 `MinimalAPI` 的使用见下文「UE C++ 插件的模块导出」。

## UE C++ 插件的模块导出

- 编写或修改 UE C++，尤其是插件代码时，默认不添加任何 `模块名_API` 导出宏（如 `SPGAMEFRAMEWORK_API`、`PROJECT_API`）；只有已确认存在其他模块的实际 C++ 调用或链接需求时才按需添加，不因声明位于 `Public`、带反射宏、Blueprint 可见或「以后可能复用」就导出。
- 禁止在类声明上添加 `模块名_API` 来整体导出类。需要跨模块使用的 UObject 反射类，仅按需在 `UCLASS(...)` 中添加 `MinimalAPI`（准确拼写），类声明仍不加导出宏；仅模块内部使用的类不添加 `MinimalAPI`。普通 C++ 类不适用 `MinimalAPI`，同样保持无整类导出宏。
- `MinimalAPI` 不会自动导出所有成员函数；仅对其他模块实际需要调用/链接的函数声明添加所属模块的 `模块名_API`，例如 `SPLEVELEDITOR_API void Execute();`，包括确有需求的构造或生命周期函数。其余函数保持不导出，不用整类导出解决个别函数的链接问题。
- 仅供 Lua/UnLua 通过 UE 反射调用或访问的类、函数和属性，不因 Lua 使用而添加 `模块名_API` 或 `MinimalAPI`；按绑定机制保留必要的 `UCLASS`、`UFUNCTION`、`UPROPERTY` 等声明即可。若另有跨模块原生 C++ 调用或绑定实现中的符号链接需求，再按实际 C++ 需求逐函数判断，不能把 Lua 调用等同于跨模块 C++ 导出。
- 成员变量不得添加 `模块名_API`。其他模块需要读取成员值时，通过按需新增的访问函数获取；函数按跨模块需求单独导出，优先返回值或只读视图，不暴露可修改的内部状态。
- 修改或新增导出宏前，先核对调用方模块、`Build.cs` 依赖、Public/Private 头文件边界、跨模块 include/调用及符号实现位置；不能仅凭 Blueprint 可见性推断需要 C++ 导出。内部实现保持无导出宏，跨模块契约才导出；无法证明存在跨模块引用时默认不加。接口、普通 C++ 类型或非 `UCLASS` 反射类型需按其实际机制逐函数处理，不套用 `UCLASS(MinimalAPI)`。
- 变更后按项目要求验证 UHT、编译和跨模块链接；不得只验证定义方模块就声称调用方可用，也不为本规则批量改写任务范围外的既有导出或成员访问。

## 缩进、对齐与空白

- 按 `NkHUD` 风格使用 Tab 表示缩进层级；大括号独占一行。空白行区分大组，单个字段之间按是否有独立说明决定是否空行。
- 同一紧凑变量组内以空格列对齐类型、变量名及必要的行尾说明；不同组独立对齐，避免为了全文件最长类型拉出过宽空白。反射属性各自带 `UPROPERTY` 时不强制列对齐到跨段落的同一列。
- 连续的相关赋值可对齐 `=`；单个赋值不填充空格。优先保持语义顺序，不为对齐重新排序字段。
- 构造函数初始化列表使用 `:` 单独一行，成员名和括号按列对齐，成员顺序与声明顺序一致；只初始化需要显式初始化的成员。多次继承或存在 UE 特殊初始化约束时遵守编译器要求。
- 调用、定义、条件和模板保持样本中的间距：`if ( Condition )`、`Foo( Value )`、`TArray< FItem >`、`if ( !Object )`；已有模块若采用另一套一致格式，不为局部变更制造混杂。

## 注释

- 头文件的类型和较大成员区域可使用 `///-----` 分隔线与简短组名；每个非显然字段说明用途、单位或资源语义，必要时使用行尾注释。重复的变量不机械追加相同注释。
- 接口、生命周期重载及需要交代调用前提的声明使用简短说明；`BeginPlay`/`EndPlay` 等成对函数可说明各自资源生命周期职责。
- `.cpp` 普通函数前**不强制**复制 `//====`、`@brief` 或头文件描述；只有非显然约束、算法原因和生命周期注意点才补充注释。不要为了模仿样本生成过时日期、版权信息或错误的类型标题。

## `.cpp` 控制流

- `.cpp` 首个 include 是对应头文件，后续按项目/依赖/UE 分组。
- 无副作用的单行 guard 可写 `if ( !Object ) return;`；多语句分支使用独占行的大括号；`else` 单独一行。
- `switch` 内 `case` 与 `switch` 体对齐；相同逻辑的标签相邻。多语句或声明局部变量的 `case` 使用独立 `{ }` 作用域，`break` 放在块后同级；简单分支可以 `case ...: return ...;`。
- 同一作用域中连续修改同一数据对象时按逻辑分组并对齐赋值，不对不同语义区域强行对齐。

## 日志输出格式

新增或修改 C++/UE 代码输出日志时，日志消息必须包含 `类名=>函数名` 定位标识，并复用项目已有日志接口：

```text
[模块名称] 类名=>函数名  具体日志内容
```

- 类/对象方法使用“类名=>函数名”；静态或自由函数使用“命名空间或模块名=>函数名”。不得只写函数名，也不得只靠日志前缀定位。
- 函数标识符与具体日志内容之间固定两个空格；其余字段按项目现有约定分隔。
- 必须先确认日志所属类/对象和函数上下文，不得根据文件名或日志内容猜测；无法确认时先补充上下文，不得生成缺少定位信息的日志。
- UE 沿用现有 `UE_LOG( 类别, 详细级别, ... )`：类别和级别写在宏参数里，不新增日志类别，也不把级别重复写进消息。
- 示例：`UE_LOG( LogExampleHUD, Log, TEXT( "[HUD] AExampleHUD=>DrawHUD  开始绘制 Value=%.2f" ), Value );`
- 本规则不要求批量重写未涉及的旧日志，也不改变现有日志接口、过滤或级别语义。

## 示例

下面演示布局与格式；声明在 `.h`，定义在对应 `.cpp`。版权行仅在项目已配置实际版权文本时填入。

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
	float ViewportScale;	// 当前视口缩放
	bool  bCanDraw;		// 是否允许绘制

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
	void DrawValue( float Value );

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

	DrawValue( HudStyle.FontScale );
}

bool AExampleHUD::CanDraw() const
{
	return bCanDraw;
}

void AExampleHUD::DrawValue( float Value )
{
	switch ( Value > 0.f ? 1 : 0 )
	{
	case 1:
		{
			DrawText( TEXT( "HUD" ), FColor::White, 0.f, 0.f );
		}
		break;
	default:
		return;
	}
}

void AExampleHUD::SetCanDraw( bool bEnabled )
{
	bCanDraw = bEnabled;
}
```

## 自检

写完后检查：反射宏和 generated include 合法；头文件声明尽量单行；分组与可见性合理；Tab 缩进、组内列对齐及初始化顺序正确；私有函数无 `_` 前缀；UE 代码没有整类导出、导出宏只加在确有跨模块需求的函数上；`.cpp` 实现顺序对应声明；`if`/`switch` 作用域正确；注释解释意图而不复述代码；新增日志包含 `类名=>函数名` 定位。实际 UE 项目还需按项目版本运行 UHT/UBT 和相关测试，不能把格式检查当成编译通过。
