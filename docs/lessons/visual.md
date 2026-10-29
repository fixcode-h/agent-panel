---
paths: web/src/index.css, web/src/components/ui/**, web/src/components/layout/**, web/src/pages/**, web/src/components/settings/ComponentsSection.tsx, web/src/components/tasks/ConversationTabs.tsx, web/src/components/tasks/Messages.tsx, web/src/components/tasks/ToolRow.tsx
---

# 视觉：部件、底色和字重

## 边界靠底色分，字不能细

- 规则：分区、选中、次要按钮、小标签靠底色深浅区分，不描边、不加阴影；只有输入框、工具行、弹窗这类必须看出边界的地方留一圈细线。差异照 Claude Code 只用底色（`components/ui/diff-tone.ts`）。
- 例外：插在文字里的行内卡片（图片、文件、Skill、引用）按类型着色加同色细内框，统一用 `components/ui/chip-tone.ts` 的 `CHIP_TONE`；只靠中性浅底时它们在用户气泡（同为 `bg-sel`）里看不出来，用户说「太不明显了」。
- 规则：常规字重 450（`--font-weight-normal`，Maple Mono 的 400 偏细），不用 `font-light` / `font-thin`；主次用颜色（fg / muted / subtle）和字号分，500 / 600 只给名字和标题。
- 规则：页面只用 `components/ui` 的部件拼，新加或改了部件在设置 → 组件（`ComponentsSection.tsx`）里加一格，换配色时一眼能看全。
- 起因：界面重设计时用户指出「不要加乱七八糟的描边」「字体不要太细」。
- 防线：`scripts/rules-check.mjs` 拦细字重；`scripts/ui/05-settings.mjs` 检查组件页。

## 吸顶元素要贴住滚动区顶边

- 规则：滚动区有上内边距时 `sticky top-0` 会留缝露出背后内容，写 `-top-<n> -mt-<n>` 并把内边距补回自己的 `pt`。防线：`scripts/ui/harness.mjs` 的 `stickyLeakProblems`（起因：设置左栏标题上方露出「快捷键」）。

## 深色下分段切换要认得出选中项

- 规则：分段切换（模式切换、`Segmented`）用 `seg-track` / `seg-thumb`，不手写 `bg-sel` + `bg-card`：深色下两者只差几个色阶，选中项认不出来；未选中文字用 `text-muted`。防线：`scripts/ui/harness.mjs` 的 `segmentedContrastProblems`（起因：用户反馈侧栏「Agent / Chat / 设计」深色下看不清）。

## 思考过程保持原样，不并进过程行

- 规则：对话里的「思考过程」是一行小字按钮（Brain 图标 + 用时）加展开后左侧竖线的正文，不改成过程行（RowShell）样式；统一部件时先问这一块。起因：90e8f53 把它改成过程行，用户要求「思考过程用原有的」。

## 过程行默认带浅底，行间不画分隔线

- 规则：工具 / 过程行（`RowShell`）每行一块默认浅底的圆角块（`bg-fg/[0.035]`），悬停再深一点；相邻行靠 4px 间距分开，不画分隔线（`index.css` 的 `proc-list`）。起因：dc23450 照设计稿改成「无底、行间细线、悬停才出底」，用户要求「工具不加分割线，背景默认显示」。

## 输入框上方的状态栏保持三行：计划、子任务、子对话

- 规则：输入框上方固定三行轻量状态栏（`data-status-row` 为 plan / helpers / children），计划是一小段字加细进度条（`w-fit`，不撑满成浅底条）；不因为运行区或页签里也有就删掉子任务、子对话两行。计划弹窗可以按设计改，折叠行不动。起因：5b72252 删了子任务、子对话栏，dc23450 把计划改成整条浅底，用户要求「输入框的计划和子任务恢复到原来的样式和布局」。

## 去掉一个入口前，先看它挂着哪些功能

- 规则：用户说某个小块「可以去掉」时，先列出它点开后的功能（切分支、独立分支列表、CLI 额度…），没有别处承接的就挪到新位置，不连功能一起删。输入框下的环境块收进会话栏「环境」标题行的分支图标，会话栏不在时（窄屏、子对话面板）仍放在输入框下。
