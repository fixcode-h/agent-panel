# ADR 0080：本机偏好注册表（localStorage 只走一个入口）

状态：已接受 · 2026-11-23

## 背景

「可统一能力盘点」第 12 项：网页里约 180 处直接读写 localStorage，每处自己 try/catch（隐私模式下访问就抛错），键名没有统一规矩；用户把分栏拖乱、折叠了分组之后没有地方恢复，只能清浏览器数据，连主题和语言一起丢掉。插件（UE 页）也各记各的。

## 决策

`web/src/lib/prefs/index.ts`（开放给插件）：

- `local.get / set / remove / json / setJson / keys`：带兜底的读写，写了通知订阅方。
- `registerPrefs([{ id, key | prefix, label, group, owner? }])`：按「族」登记——一个固定的键，或一个前缀下的一组键。`group` 分 `layout`（尺寸、折叠）、`view`（页签、筛选、打开的内容）、`settings`（主题、语言这类真正的设置）、`other`。面板自己的族在 `web/src/lib/prefs/builtin.ts`，启动时登记；插件在网页激活时登记（UE：`ue:`、`ue.gt.`、`ue-perf-custom-channels`）。
- 设置 → 外观 →「界面状态」：按组列出现在有存值的族，每项可重置；「全部重置」只清 `layout` 和 `view`，主题、语言、GameTest 断点这类不动。

已换过来的：分栏（split-pane）、拖边宽度（resize）、弹窗大小、左侧图标栏、对话右栏的视图状态。

## 影响

- 新代码读写 localStorage 用 `local.*`，新键在 `builtin.ts`（插件用 `registerPrefs`）登记族，设置页才列得出、重置得了。
- 结构检查加一项 `localStorage`：每个文件直接用 localStorage 的处数只许变少（基线 `scripts/structure-caps.json`），旧代码改到时顺手换成 `local.*`。
