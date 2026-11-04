# 行内小标签和同一行文字不垂直居中（Markdown 行内代码 `.lua` / `1275266` 最明显）

- 状态：已修复（`npm run typecheck`、`npm run lint`、`node scripts/ui-check.mjs 02-task` 通过）
- 症状：对话回复里的行内代码小标签（`2 个 .lua`、`P4 CL 1275266`）和同一行的正文文字不在一条视觉中线上，字在色块里偏上；同类的状态胶囊（「等你回复」）、子对话行徽标（「计划 1/2」）、工具行徽标（「汇报」「传话」）、对话页页签文字也有同一类偏差（0.8~1.9px）
- 入口：`web/src/index.css` 的 `.chat-md :not(pre) > code`、`@utility chip-lift`、`@utility text-optical-center`；引用处 `components/ui/badge.tsx`、`components/ui/status-pill.tsx`、`components/ui/tab-bar.tsx`、`components/tasks/child-line.ts`、`components/tasks/ToolRow.tsx`、`components/tasks/ChildAskCard.tsx`
- 根因类型：字形的墨迹中心比字体盒中心高一点（汉字约 0.05em），色块按 baseline 或 flex 居中排时色块整体偏低、文字在色块里偏上；补偿值原先没有公共位置，各处写法不一致
- 模块：`web`
- 关键词：行内代码、inline code、垂直居中、vertical-align、baseline、chip、badge、页签、对齐、chip-lift、text-optical-center、字重

## 现象

用户报「`.lua` 怎么和文本不对齐，怎么不是纵向居中」，截图是对话回复里的一行：

```
2. G 演出进出切 Protagonist (P4 CL 1275266, 2 个 .lua)
```

`1275266`、`.lua`、`2.` 是渲染出来的行内代码小标签（深色底 + 1px 边框 + 橙色字）。色块和同行正文错开，色块里的字上下留白不对称（上方 5px、下方 6px，20px 高的块）。

用户随后要求在真实浏览器里把所有同类位置一起查：「不仅仅是那个标题，看看有其他同样他类型的问题没，一起修改」，并明确要求做法是「一个地方调整其他地方一起变化」。

## 测量

Playwright 打开 demo 产物，用 canvas `measureText` 量字形墨迹（`actualBoundingBoxAscent/Descent`），

- 量「色块矩形中心」和「同一行相邻汉字的墨迹中心」的差（`dev`）；
- 量「色块内的文字墨迹中心」和「色块中心」的差（`inner`）。

默认设置（14px 正文、Maple Mono NL）下：

| 位置                                       | 改前 dev | 改后 dev   |
| ------------------------------------------ | -------- | ---------- |
| Markdown 行内代码（`.chat-md code`）       | 1.00px   | 0.05px     |
| 工具行徽标（`ToolRow` 的「汇报」「传话」） | 1.92px   | 1.05px     |
| 子对话行徽标（「计划 1/2」）               | 1.35px   | 0.48px     |
| 状态胶囊（侧栏「等你回复」）               | 0.78px   | -0.09px    |
| 通用 `Badge`（「必备」「内置」这类）       | 1.58px   | 0.7px 以内 |
| 对话页页签文字（对页签条中心）             | -1.58px  | -0.03px    |

深色 / 浅色两套主题、12~18px 五档字号、三种 mono 字体下复测，偏差都跟着字号按 em 缩放，没有出现某一档反过来偏。

## 根因

1. **字形墨迹中心 ≠ 字体盒中心。** 汉字的墨迹大致落在 baseline 上方 0.88em 到下方 0.12em，中心比 em 框中心高约 0.05em。`vertical-align: baseline` 的行内代码、`items-center` 的 flex 胶囊都是「盒对盒」对齐，排出来色块天然比字形低一档，字号越小越明显（12px 时约 1px，用户把界面字号调到 16~18 时到 2px）。
2. **色块内的上下留白也不对称。** `py-px` + 1px 边框对 em 框对称，但 em 框底部有一段 descender 空白，字形在块里看起来偏上 0.5px。
3. **页签方向相反。** 页签是固定高度条里 `items-center` 排版，文字（行盒）中心比字形中线低，看起来浮在条的上半部 1.6px。
4. **原先没有公共位置。** 行内代码的 padding 写在 `index.css`，徽标的 padding 写在各自的 Tailwind 类里，页签的对齐靠 `items-center`；修一处不会影响别处，换个字号又要重调。

## 修复

对齐数值只写在 `web/src/index.css` 两处（同一对「盒中心 / 字形中心」的差，方向相反）：

- `@utility chip-lift`：`position: relative; top: calc(-1 * var(--chip-lift, 0.08em))`。行内元素不吃 `transform`，用相对定位提色块；`0.08em` 跟着字号缩放。
- `@utility text-optical-center`：`top: var(--text-optical-drop, 0.13em)`。固定高度条里的文字、标签、关闭按钮往下补同样多。

其余文件只做一件事：把内联样式换成引用这两个类。

- `.chat-md :not(pre) > code`（含 `code.md-path`，同一条选择器）`@apply chip-lift`
- `.chat-md .md-card-kind`（总结卡类型标签）`@apply chip-lift`
- `components/ui/badge.tsx`（`Badge` 基类）、`components/ui/status-pill.tsx`（`StatusPill` 基类）加 `chip-lift`
- `components/tasks/child-line.ts` 的三个带底色标签、`ToolRow.tsx` 的徽标、`ChildAskCard.tsx` 的「等{who}选择」、`ProjectSkillsSection.tsx` 的问题计数、`Attachments.tsx` / `StyleLibrary.tsx` / `DesignProjectDialog.tsx` 的「内置」加 `chip-lift`
- `components/ui/tab-bar.tsx` 的标题、页签里的计数标签加 `text-optical-center`（关闭按钮只有图标、没有字形，几何居中就是对的，不加；右栏的 `variant="fit"` / 页内的 `underline` 页签高度跟着内容走、本来就居中，也不加）

评审后按实测收窄了三处「加了反而更差」的：

- `.chat-md .md-card-kind`（总结卡类型标签）：它的父容器 `.md-card-head` 是 `items-baseline`，标签和标题本来严格同基线，提上去会比标题高 0.9px —— 不加。
- `tab-bar.tsx` 的关闭按钮：唯一子元素是 X 图标，没有字形墨迹，下移 1.56px 只会把悬停底色块和点击热区压到条中线以下 —— 不加。
- `ChildAskCard.tsx` 的「等{who}选择」：这一行带脉冲圆点、行高 18px，实测改前它的文字就比同行正文高 3.7px（不是偏低），提上去变成高 4.6px —— 不加，留在已知问题里。

`--chip-lift` 只在页面级覆盖过（浏览器里设成 0 / 0.08em / 0.2em 量三组）验证「一个变量带动全部」：行内代码 1.00 → 0.05 → -1.41，工具行徽标 1.92 → 1.05 → -0.27，子对话行徽标 1.35 → 0.48 → -0.84，三处同步移动。

能不能收敛的边界：Radix / 第三方组件内部（sonner 提示条、mermaid 生成的 SVG、CodeMirror 和流程图节点里的文字）不套这两个类；它们的对齐由组件自己决定，改不到也不该用面板的变量去改。

## 防线

- `scripts/ui/harness.mjs` 的 `chipAlignProblems`：扫 `.chat-md code` 和所有 `.chip-lift` 元素，量胶囊中心与同一行汉字墨迹中心的差，超过 1.5px 就报一条。
  - baseline 不用往页面里插探针（会拆开 React 的文本节点），用单字符 Range 的矩形（行内盒）+ canvas 的 `fontBoundingBoxAscent/Descent` 算：`rect.top + (rect.height - em高) / 2 + ascent`。第一版拿 `fontSize` 当 em 高，和探针法实测差 2px，导致误报，已按实测校准。
  - sr-only 一类 1px 宽的说明文字不当参照（会算出 -6.5px 的假偏差）。
- `scripts/ui/02-task.mjs` 有「行内标签垂直对齐」和「页签文字垂直居中」两步：前者调 `chipAlignProblems`（扫 `.chat-md code`、`.chip-lift`、页签里的计数标签），后者调 `tabAlignProblems`（带 `text-optical-center` 的元素，量文字中心与页签条中心的差）。
- 口径：这条只量「被补偿过的行内小标签」，基准是「盒子中心 vs 同一行文字的墨迹中心」。**基线对齐、按设计不该补偿的元素不在里面**（例如 `items-baseline` 卡片头里的 `.md-card-kind`：它的盒中心天然比标题墨迹中心低 1.4px 左右，加进断言会逼着人把它提离基线）。另外胶囊的盒子中心比胶囊里的字中心恒定低约 0.5px（字比盒子小的那部分），所以断言数值和「字对字」的实测值差这个常数，不必对齐。
- 测量口径的两个坑（都实测校准过）：baseline 要用单字符 Range 的矩形 + canvas 的 `fontBoundingBoxAscent/Descent` 算（拿 `fontSize` 当 em 高会偏 2px）；参照字符要用**实际选中的那个字符**（拿「x」的 x-height 代表大写的「G」差 1.4px，正好等于容差），汉字优先、其次字母数字、1px 宽的 sr-only 说明文字不参与。
- **对照验证**：把 `--chip-lift` / `--text-optical-drop` 设成 `0em`（等于改前）在任务页跑，`chipAlignProblems` 报 5 条（「汇报」「传话」「交代任务」各 1.92px）、`tabAlignProblems` 报 1 条（页签标题 -1.58px）；恢复默认值后都是 0 条。新增 chip 忘了加 `chip-lift`、或把补偿值改坏，这一条会失败。
