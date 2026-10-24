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

## 画板运行时假数据（不导出）

设计文档（`DesignDoc.data`）里可以带一份只给画板预览用的运行时假数据（`shared/design-data.ts`）：

```jsonc
{
  "data": {
    "sets": [
      {
        "id": "items",                     // 面板内部 id；normalizeData 在 AI 只写 name 时按 name 补
        "name": "Items",                   // 绑定用的英文标识
        "label": "背包物品",
        "fields": [
          { "key": "icon", "label": "图标", "type": "image", "widget": "Icon", "note": "" },
          { "key": "count", "label": "数量", "type": "number", "example": 1 },
          { "key": "selected", "label": "选中", "type": "boolean", "example": false },
          { "key": "locked", "label": "锁定", "type": "boolean", "example": false }
        ],
        "rows": [
          { "icon": "img:sword", "count": 1, "selected": true, "locked": false },
          { "icon": "", "count": 0, "selected": false, "locked": true }
        ]
      }
    ]
  }
}
```

- `type` 是 `string` / `number` / `boolean` / `image` / `color`；`image` 的值写设计里图片的 `img:<id>`。
- `widget` 记这个字段对应条目子控件里的哪个控件，只给面板显示，不影响渲染。
- 数据存在设计文档顶层，和控件树、图片一起保存；AI 通过 `set_data` 工具写入（结构化结果里是 `AiDesignResult.data`），数据面板也能直接改。
- 画板按数据渲染出接近真实运行的效果（格子里有物品图标、数量、选中 / 锁定态），这份数据不进 UE，也不进网页导出。

### 绑定规则

只认控件 `Properties` 里的三个属性，都在条目子控件内部声明：

| 属性 | 写在哪 | 作用 |
| --- | --- | --- |
| `DataSet` | 列表控件（UniformGridPanel、ListView、TileView、DynamicEntryBox） | 值是集合的 id 或 name，画板上的条目数就是集合的行数（集合没有行时不画条目）；没绑定或集合不存在时按 `NumEntries` / `NumDesignerPreviewEntries` 预览空条目 |
| `DataField` | 条目子控件里要显示数据的控件 | 值是字段 key，按控件类型显示这一行的值 |
| `States` | 任意控件（通常写在条目子控件里） | 当前行满足条件时换一套属性，见下 |

`DataField` 按控件类型换成的属性（`DATA_BINDING`）：

| 控件 | 属性 | 说明 |
| --- | --- | --- |
| TextBlock、EditableTextBox、Text、WebButton | `Text` | 转成字符串 |
| Image | `Brush.ResourceObject` | 值是 `img:<id>` 时换图；空字符串把控件设为 `Visibility: "Hidden"`（空格子没有图标） |
| Picture | `Src` | 同上，网页用 |
| ProgressBar | `Percent` | 限制在 0~1 |
| CheckBox | `CheckedState` | `true` 为 `Checked`，否则 `Unchecked` |
| Input | `Value` | 转成字符串 |

不在表里的控件只套用 `States`，不显示数据。

### 状态

```jsonc
"States": [
  { "Name": "Selected", "When": { "Field": "selected", "Equals": true }, "Properties": { "Brush": { "ResourceObject": "img:slot_selected" } } },
  { "Name": "Locked",   "When": { "Field": "locked", "Equals": true },     "Properties": { "ColorAndOpacity": "#808080FF" } },
  { "Name": "Normal",   "Properties": {} }
]
```

- 按顺序取**第一个匹配**的状态：`When.Field` 的值和 `When.Equals` 比较时统一转成字符串（数据面板填的 `"true"` 和 AI 写的 `true` 都能匹配）。
- 不写 `When` 就是默认状态；没有状态匹配时用控件原本的属性。
- 匹配到的 `Properties` 深合并到控件属性上，再套用 `DataField`。
- 状态图仍然走设计里的图片资源（`"img:<id>"`），选中态的描边 / 发光图放在条目子控件的 Image 里，由 `States` 换 `Brush.ResourceObject`，**不要**把状态效果图单独贴在画布对应位置。
- 画板渲染不改原来的树：`withRow` 返回新的控件，设计器里看到的属性和保存的数据不受影响。

### 导出时剔除

- **UMG**（`exportDesign` / `exportWidget`）：导出结果按 `Format` / `Version` / `Name` / `DesignSize` / `Textures` / `UserWidgets` / `Root` / `Animations` 重新拼，顶层没有 `data`；每个控件的 `Properties` 里删掉 `DataSet`、`DataField`、`States`（`DATA_PROPS`）。
- **网页**（`webExport` / `webReactExport`）：只输出控件的具名属性（文字、图片、样式），三个绑定属性不会出现在 HTML / CSS / TSX 里。
- **导出到项目目录**用的是同一份 JSON，和 ZIP、单个 JSON 的内容一致。
- UniformGridPanel 导出时格子数仍按 `NumEntries` 展开，不按示例行数；要让画板和导出一致，把 `NumEntries` 设成和示例行数相同。
- 单测在 `shared/design-data.test.ts`：`exportDesign：假数据和状态绑定都不进导出结果`、`webExport：状态和数据绑定也不出现在网页导出里`，断言导出文本里不含 `DataSet` / `DataField` / `States`，也不含示例数据里的字符串和 `img:` 引用。

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
