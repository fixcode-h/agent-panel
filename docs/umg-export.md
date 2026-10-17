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
