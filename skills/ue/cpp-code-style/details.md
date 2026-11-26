# C++ 代码格式：细则与示例

入口是同目录的 `SKILL.md`，这里是它提到的细则。

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
