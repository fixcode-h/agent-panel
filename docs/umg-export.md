# UI 设计导出格式（AgentPanel.UMG）

UI 设计页「导出」得到的数据，用来在 UE5 里生成 Widget Blueprint。导出有三种形式，内容一样：

- **ZIP**：`WBP_<名字>.umg.json` + `Textures/T_<图片名>.png`
- **单个 JSON**：贴图以 base64 放在 `Textures[].Data`
- **导出到项目目录**：写到 `<项目目录>/UI/WBP_<名字>/`，文件和 ZIP 里一样

控件类型、插槽、属性的名字和取值都照搬 UE5 的 UMG（C++ / 蓝图里的属性名），导入工具可以按名字直接反射赋值。

## 顶层结构

```jsonc
{
  "Format": "AgentPanel.UMG",
  "Version": 1,
  "Name": "WBP_MainMenu",              // 蓝图名，PascalCase
  "DesignSize": { "X": 1920, "Y": 1080 },
  "Textures": [
    {
      "Name": "T_ButtonFrame",          // 导入后的贴图资源名
      "File": "Textures/T_ButtonFrame.png",
      "Size": { "X": 320, "Y": 72 },
      "NineSlice": { "Left": 0.2, "Top": 0.3, "Right": 0.2, "Bottom": 0.3 }, // 可选，0~1 的比例
      "Data": "iVBORw0..."              // 只在单个 JSON 里有
    }
  ],
  "UserWidgets": [                       // 提取出来的子控件，各自生成一个 Widget Blueprint
    { "Name": "WBP_MenuButton", "DesignSize": { "X": 320, "Y": 72 }, "Root": { /* 控件 */ } }
  ],
  "Root": { /* 控件 */ }
}
```

导入顺序：先导入贴图，再生成 `UserWidgets`（主界面会引用它们），最后生成主界面。

## 控件

```jsonc
{
  "Type": "Button",                     // UMG 控件类名去掉 U 前缀
  "Name": "Btn_Start",                  // 控件名，同一棵树里不重复
  "Class": "WBP_MenuButton",            // 只有 Type 为 UserWidget 时有：引用的子控件
  "Slot": { "Type": "VerticalBoxSlot", /* 插槽属性 */ }, // 根控件没有
  "Properties": { /* 控件属性 */ },
  "Children": [ /* 子控件 */ ]           // 只有面板类控件有
}
```

支持的类型：CanvasPanel、Overlay、HorizontalBox、VerticalBox、UniformGridPanel、WrapBox、ScrollBox、SizeBox、ScaleBox、Border、WidgetSwitcher、ListView、TileView、DynamicEntryBox、Spacer、Image、TextBlock、Button、CheckBox、ProgressBar、Slider、EditableTextBox、UserWidget。

UniformGridPanel 在设计器里不放子控件，格子在属性里设（每个格子用哪个子控件、格子数、列数）；导出时展开成 UE 里真正的子控件：每个格子一个 `UserWidget`，`UniformGridSlot` 的 Row / Column 和对齐都已填好，网格自己只留 UE 有的属性（SlotPadding、MinDesiredSlotWidth / Height）。

ListView、TileView、DynamicEntryBox 的条目是游戏运行时按数据生成的，导出数据里没有 `Children`；`Properties.EntryWidgetClass` 是条目用的子控件名（`UserWidgets` 里的一个），导入时设成对应的 Widget Blueprint，`NumDesignerPreviewEntries` 是设计器里预览几条。

## 取值约定

- **颜色**：`{ "R", "G", "B", "A", "Hex" }`。R/G/B 是线性空间（`FLinearColor`），`Hex` 是界面上看到的 sRGB `#RRGGBBAA`，用 `FColor::FromHex` 也可以。
- **图片**：画刷的 `ResourceObject` 是贴图名（`T_xxx`），空字符串表示没有图片。`DrawAs` 为 `Box` 时按贴图的 `NineSlice` 或画刷自己的 `Margin` 九宫格拉伸。
- **CanvasPanelSlot**：`LayoutData.Offsets / Anchors / Alignment`、`bAutoSize`、`ZOrder`，和 `FAnchorData` 一致。
- **SizeBox**：除了 `WidthOverride` 等数值，还带 `bOverride_WidthOverride` 等开关（数值大于 0 时为 true）。
- **字体**：`Font.Size` 是 UE 的字号，`TypefaceFontName` 是 Regular / Bold / Italic，字体资源由导入工具指定。
- 枚举写 UE 的枚举名，比如 `HAlign_Center`、`VAlign_Fill`、`Visible`、`ScaleToFit`。

## 动画（Animations）

主界面和每个 `UserWidgets[]` 各自带 `Animations`，对应 Widget Blueprint 里的 WidgetAnimation（没有动画时是空数组）：

```jsonc
{
  "Name": "Anim_Open",                 // WidgetAnimation 名
  "Length": 0.45,                      // 秒，最后一个关键帧的时间
  "Trigger": "Construct",              // Construct（打开时播放）| Hover（Source 悬停时正放、移开倒放）| Click（Source 点击时）| Manual（蓝图里自己 PlayAnimation）
  "Source": "Btn_Start",               // 只有 Hover / Click 有：绑定事件的控件
  "NumLoops": 1,                       // 0 表示一直循环（PlayAnimation 的 NumLoopsToPlay）
  "PlayMode": "Forward",               // Forward | PingPong
  "Delay": 0,                          // 开始前等多久（秒）
  "Tracks": [
    {
      "Widget": "Panel",                       // 控件名（同一个 Widget Blueprint 里）
      "Property": "RenderTransform.Scale",     // RenderOpacity | RenderTransform.Translation | RenderTransform.Scale | RenderTransform.Angle
      "Keys": [                                // 直接用的关键帧：Linear / Constant 插值
        { "Time": 0, "Value": { "X": 0.6, "Y": 0.6 }, "Interp": "Linear" },
        { "Time": 0.0333, "Value": { "X": 0.71, "Y": 0.71 }, "Interp": "Linear" }
      ],
      "Source": [                              // 设计里的原始关键帧和缓动，想自己设切线时用
        { "Time": 0, "Value": { "X": 0.6, "Y": 0.6 }, "Ease": "back-out" },
        { "Time": 0.45, "Value": { "X": 1, "Y": 1 }, "Ease": "ease-out" }
      ]
    }
  ]
}
```

- `Value` 对 RenderOpacity、Angle 是数字，对 Translation、Scale 是 `{ X, Y }`；Translation 单位是 Slate 像素，Angle 是度。
- 缓动（ease-out、back-out、弹簧、弹跳等）在 `Keys` 里已经按 30 帧取点成线性关键帧，导入时照着加关键帧就和设计里的预览一致；线性和跳变（constant）不取点。
- 导入时：为每个动画新建 WidgetAnimation，给 `Widget` 绑定 Possessable，按 `Property` 建 Float 轨道（RenderOpacity）或 2D Transform 轨道（RenderTransform 的各通道），把 `Keys` 写进去；`Trigger` 为 Construct 的在 Event Construct 里 PlayAnimation，Hover / Click 绑到 `Source` 控件的 OnHovered / OnUnhovered / OnClicked。

网页 UI 的导出（HTML、React）里，动画由页面里的一小段播放代码（浏览器自带的 Web Animations，不依赖动画库）按触发方式播放：打开时、滚动到可见时、悬停（移开倒放）、点击；`window.uiAnim.play('动画名')` 可以手动播放。
