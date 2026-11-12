---
paths: web/src/index.css, web/src/components/ui/**, web/src/components/layout/**, web/src/pages/**, web/src/components/settings/ComponentsSection.tsx, web/src/components/tasks/ConversationTabs.tsx, web/src/components/tasks/Messages.tsx, web/src/components/tasks/ToolRow.tsx
---

# 视觉：部件、底色和字重

## 边界靠底色分，字不能细

- 规则：分区、选中、次要按钮、小标签靠底色深浅区分，不描边、不加阴影；只有输入框、工具行、弹窗这类必须看出边界的地方留一圈细线。差异照 Claude Code 只用底色（`web/src/components/ui/diff-tone.ts`）。
- 例外：插在文字里的行内卡片（图片、文件、Skill、引用）按类型着色加同色细内框，统一用 `web/src/components/ui/chip-tone.ts` 的 `CHIP_TONE`；只靠中性浅底时它们在用户气泡（同为 `bg-sel`）里看不出来，用户说「太不明显了」。
- 规则：常规字重 500、`font-medium` 550（`--font-weight-normal` / `--font-weight-medium`；用户 2026-10-31 要求「字体都用加粗一点的版本」，450 时中文落到 400 显得细），不用 `font-light` / `font-thin`；主次用颜色（fg / muted / subtle）和字号分，600 只给名字和标题。思源黑体因此打 400 / 500 / 600 三档。
- 规则：页面只用 `components/ui` 的部件拼，新加或改了部件在设置 → 组件（`ComponentsSection.tsx`）里加一格，换配色时一眼能看全。
- 起因：界面重设计时用户指出「不要加乱七八糟的描边」「字体不要太细」。
- 防线：`scripts/rules-check.mjs` 拦细字重；`scripts/ui/05-settings.mjs` 检查组件页。

## 吸顶元素要贴住滚动区顶边

- 规则：滚动区有上内边距时 `sticky top-0` 会留缝露出背后内容，写 `-top-<n> -mt-<n>` 并把内边距补回自己的 `pt`。防线：`scripts/ui/harness.mjs` 的 `stickyLeakProblems`（起因：设置左栏标题上方露出「快捷键」）。

## 深色下分段切换要认得出选中项

- 规则：分段切换（模式切换、`Segmented`）用 `seg-track` / `seg-thumb`，不手写 `bg-sel` + `bg-card`：深色下两者只差几个色阶，选中项认不出来；未选中文字用 `text-muted`。选中块要更显眼的地方（侧栏顶部的模式 tab）用加强的 `seg-thumb-strong`：描边 + 投影 + 加重字重，深色下再提亮一档并加白环（用户要求「选中的时候样式要明显一点」）。防线：`scripts/ui/harness.mjs` 的 `segmentedContrastProblems`（起因：用户反馈侧栏「Agent / Chat / 设计」深色下看不清）。

## 去掉一个入口前，先看它挂着哪些功能

- 规则：用户说某个小块「可以去掉」时，先列出它点开后的功能（切分支、独立分支列表、CLI 额度…），没有别处承接的就挪到新位置，不连功能一起删。输入框下的环境块收进会话栏「环境」标题行的分支图标，会话栏不在时（窄屏、子对话面板）仍放在输入框下。

## 提问相关的标签称呼用户用设置里的「称呼」，不写「你」

- 规则：提问卡片、子对话提问、等待选择这类标签写「需要{who}回答」「等{who}选择」，`who` 取 `useUserName()`（设置 → 输入与文件 →「称呼」，空时「用户」）；纯函数（`childLabels`）收一个 `who` 参数，组件里传进去。
- 起因：用户要求「提问的时候 Agent 问我不要显示你，显示用户，可以在设置中设置」。

## 相邻的两栏不能用同一个底色贴在一起

- 规则：并排的栏（图标栏和会话侧栏、侧栏和面板）要么底色差一档，要么有一道分隔线；新加一栏时用 `color-mix` 从这套配色的 rail / fg 算出来（`.activity-bar`），不另写每套配色的颜色。
- 起因：e8c094d 的图标栏和会话侧栏都是 `bg-rail`，用户反馈「侧栏和左侧栏要有边界，目前融合在一起」。

## 盖在滚动内容上的吸顶栏、浮条用毛玻璃

- 规则：吸顶栏、浮在内容上的操作条和按钮用 `frost`（bg 底）/ `frost-card`（card 底），不再写 `bg-bg`、`bg-card/95 backdrop-blur`；对话里吸顶的回复头、工作流节点标题是通栏：加 `frost-bar` 类、第一个孩子放 `<FrostBarBg />`，所在滚动区要 `overflow-x-hidden`（底左右各伸出一屏宽，靠它裁掉）。
- 起因：用户 2026-10-31 要求照 Claude Code 网页版顶栏复刻毛玻璃、回复头拉满整个横向空间，并在其他能用的地方都用上。

## 行内小标签的垂直对齐只写一处，组件里只引用

- 规则：行内代码、状态胶囊、`Badge`、子对话行徽标、页签文字和同一行正文的垂直对齐，只用 `web/src/index.css` 的 `chip-lift`（提色块）和 `text-optical-center`（降条里的文字）；数值（em，随字号缩放）只在 utility 默认值里，组件只加类名，不写 `top-px`、不对称 `padding-block` 或逐处覆盖变量。
- 起因：用户报「`.lua` 和文字不对齐」，一开始按处补偏移，用户要求「一个地方调整其他地方一起变化」——最后数值只剩 `index.css` 一处。防线：`scripts/ui/harness.mjs` 的 `chipAlignProblems`（`02-task` 分片扫行内标签，偏超过 1.5px 就失败）。

## 标签旁的文字先排正，不靠加大 chip-lift 去凑

- 规则：标签和同一行文字对不齐时，先看旁边那段文字自己是不是被抬高或压低了。常见的原因是 `inline-flex` 容器的第一个子元素是图标（没有文字基线），浏览器拿图标底边当基线，整段文字会被抬高。行里的容器用块级 `flex`，不要为了对齐去改 `--chip-lift`，也不要逐处写偏移。
- 起因：ff0008ad 给子对话收发信那一行的「汇报 / 传话 / 交代任务」加了 `chip-lift` 后，界面检查仍差 1.55px（上限 1.5px），CI 一直是红的。实测是左边对方名字的 `inline-flex`（图标打头）被抬高了约 1px，把 `PeerMessage.tsx` 改成 `flex` 就对齐了。

## :root 上的 CSS 变量里不要引用只在局部才定义的变量

- 规则：没注册的 CSS 变量里的 `var()` 在声明它的元素上就替换掉。写在 `:root` 的 `--md-*`（`shared/markdown-style.ts` 生成的、`index.css` 的默认值）里引用 `.chat-md` 上才有的 `--md-base`、`--md-k`，到 `:root` 就是无效值，往下继承的也是无效值，用到它的属性回到初始值（`max-height` 变成 `none`），也不报错。这类变量只放纯值（行数、开关），要按字号算的 `calc()` 写在用它的规则里。
- 起因：对话表格「长表限高」第一版把整段 `calc(… var(--md-base) …)` 放进 `--md-table-rows`，设置里怎么调表格都不限高。
- 防线：`scripts/ui/05-settings.mjs` 的「设置-Markdown样式-长表限高」。
