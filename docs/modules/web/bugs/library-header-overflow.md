# 技能页左栏头部的按钮顶出左栏，压到右侧内容上

- 状态：已修复（界面检查 `scripts/ui/03-library.mjs` 的「Skills与命令-不溢出」用 `boundingBox()` 断言按钮和标题的右边界 ≤ 左栏宽度）
- 症状：技能页左栏头部的「AI 创建」「新建」两个按钮顶出左栏，压到右侧内容区上
- 入口：`web/src/components/layout/ListPane.tsx` 的头部、`web/src/pages/LibraryPage.tsx` 的 `extra`
- 根因类型：标题 `shrink-0` + `whitespace-nowrap`、按钮也 `shrink-0`，左栏固定 300/320px 时无处收缩
- 模块：`web`（`web/src/components/layout/ListPane.tsx` 的头部、`web/src/pages/LibraryPage.tsx` 的 `extra`）
- 关键词：左栏溢出、超出范围、标题、AI 创建、新建、按钮顶出去、`shrink-0`、`whitespace-nowrap`、`ListPane`、窄栏

## 现象

用户在技能页截图（`attachments/截图-073150.png`）报「超出范围了」：左栏顶部那一行「**Skills 与命令** `0`　[✨ AI 创建] [＋ 新建]」里，两个按钮右半截**已经压到左栏边界之外**，和右侧内容区重叠；标题本身也是满宽，没有给按钮留位置。

## 复现

1. 浏览器宽度正常（1440），打开「Skills 与命令」页。
2. 左栏宽 320px（`md:w-[300px] lg:w-[320px]`）。
3. 头部一行要放：标题「Skills 与命令」（`text-lg` 中文约 130px）、数量徽标、`sm` 尺寸的「AI 创建」按钮（图标 + 文字 ≈ 92px）、「新建」按钮（≈ 70px），加上 `gap` 和左右 `px-4`，合计超过 320px。

## 根因

`ListPane` 的头部行（`web/src/components/layout/ListPane.tsx`）：

- 标题是 `<h1 className="shrink-0 text-lg font-semibold whitespace-nowrap">`——`shrink-0` + `whitespace-nowrap` 表示「任何时候都按内容宽度占位」，它不会给按钮让位。
- 数量徽标也是 `shrink-0`。
- 按钮区 `<div className="ml-auto flex items-center gap-1.5">` 没有 `shrink-0`，但里面两个 `Button` 都自带 `shrink-0`（`web/src/components/ui/button.tsx` 的基础类里就有）。

两边都不收缩，而父元素又不是能换行的 `flex-wrap`，于是内容总宽超过左栏时只会溢出容器——Flex 布局的默认行为，父级 `overflow` 也没有裁掉，看起来就是按钮压到右栏。

## 修复

- `ListPane` 的标题改成 `min-w-0 truncate`（`title` 属性保留完整文字），按钮区加 `shrink-0`：空间不够时**先压缩标题**，按钮永远完整可见。
- 新增可选 `compactNew`：置位时「新建」渲染成 `icon-sm` 图标按钮（文字进 `aria-label` / `title`）。技能页同时把「AI 创建」换成图标按钮（`aria-label` 是「AI 创建 Skill」/「AI 创建命令」），头部总宽缩到 320px 以内。
- 空列表的引导文案从「点右上角「新建」」改成「点右上角的 ＋ 新建」，按钮变成图标后文案仍然准确。

## 回归

- `scripts/ui/03-library.mjs` 的「Skills与命令-不溢出」：取左栏 `section[aria-label="Skills 与命令列表"]` 的 `boundingBox()`，再取「新建」「AI 创建 Skill」两个按钮和 `h1` 的 `boundingBox()`，断言 `x + width ≤ 左栏右边界 + 1`；顺带断言分页是 `combobox`。

## 防复发

- `ListPane` 是共用组件（角色页、工作流页、技能页都用）：**标题区必须能被压缩**，新加按钮时不要给它们加 `w-` 之类的固定宽度，也不要给头部行改成 `flex-wrap`（一换行，标题和按钮就不在同一行了）。
- 窄栏里放两个以上带文字的按钮，用 `compactNew` 那套图标 + `title` / `aria-label` 的做法；加按钮后要按 320px 宽确认没溢出。
