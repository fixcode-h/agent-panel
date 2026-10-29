---
paths: web/src/**, shared/i18n.ts, shared/locales/**, shared/task.ts, scripts/ui-check.mjs, scripts/ui/**
---

# 界面、文案和样式

## 文案、命名和控件的写法

- 规则：界面文案（含服务端返回给界面的报错）都走 `t()`，英文写进 `shared/locales/en/`；提示词、注释、演示数据不翻。
- 规则：字号用 rem（`text-[0.8125rem]`，不写 `text-[13px]`），设置里「字号」改根字号；字体用 `--app-sans` / `--app-mono`（`web/src/lib/appearance.ts`）；基础样式放 `@layer base`，否则盖掉工具类。单个字形难看就用同家族 `@font-face` + `unicode-range` 只换它（`web/src/maple-mono.css`）。
- 规则：配置出来的 Agent（角色设定 + CLI + 模型）界面写「角色」（2dbcf97），编码工具本身（Claude Code、Pi…）写「Agent」，如「默认 Agent」；产品名和开发者说明写 CLI，代码里的类型名、变量名不改。
- 规则：不列「默认」「自动」「CLI 默认」，直接预选并标「（默认）」；思考强度写 `english · 中文`，只列当前模型支持的档位、按 CLI 顺序，值不支持时用 `effortValue` / `defaultEffortOptions` 取最接近的，不补进下拉；停用/没装的 CLI 不出现在选择器和列表里；名字叫「Codex」不叫「Codex CLI」。
- 起因：v0.18 思考强度排序被指出（medium 排在 off 前）；「默认 CLI」改名 Agent。
- 防线：`npm run typecheck`（`scripts/i18n-check.mjs`）、`web/src/lib/cli-style.test.ts`；改了布局、弹窗、列表跑 `scripts/ui-check.mjs`，到 `ui-shots/` 看深浅两套主题。

## 拖引用、条目点法和弹窗取数

- 规则：文件拖进输入框用左键长按（`fileDrag.ts` 的 `longPressed`，约 300ms），右键留给菜单；拖完压掉补发的 click。
- 规则：对话里一行一个的条目（工具调用、子任务、面板结果、提问）用 `RowShell`：整行是入口的传 `rowOpen`（动作名、标题、详情、耗时都可点，行尾 `action` 如终止要自己 `stopPropagation`）；没传的只有标题开窗口，动作名和箭头是展开收起，`detailStart` 的详情区不吃点击（传了 `rowOpen` 除外）。
- 规则：会被角色或后台改动的数据（如项目教训）别只用页面缓存，弹窗打开时重新请求合进草稿，否则 `record_lesson` 记的教训在项目设置里看不到。
- 起因：拖引用原为右键按住拖动、子任务行只有标题能点，用户要求整行可点（参考子对话行）。
- 防线：`scripts/ui-check.mjs` 的「任务-长按拖入引用」（`scripts/ui/02-task.mjs`）、同文件「子对话-整段文本可点」「子任务-整行可点」「子任务-终止按钮不打开窗口」。

## 面板的产物不冒充用户、不另起居中提示

- 规则：面板推给 CLI 的内容（后台命令、合并编译、子任务结果）记成 `TaskMessage.panel`，画成 AI 回复的一行；面板工具调用按「做了什么 + 对象名」显示（`toolView` / `panelTool`，新工具要进 `PANEL_TOOL`），不另记居中提示，也不插提示截断回复。子对话汇报只给父对话 AI，提问是父对话的卡片（`panel: 'child'` / `'ask'`）。
- 起因：15c1a1d 把后台命令结果当用户消息推回、新建子对话另记居中提示；之后「要改文件了…」截断回复。
- 防线：`server/orch-mcp.test.ts`、`server/orchestrator.test.ts`、`scripts/e2e.mjs`（开分支不记提示、提问卡片）。

## 一个状态只允许一处判定：childIcon、working 和橙点

- 规则：子对话/任务展示只读 `shared/task.ts` 的 `childIcon(entry)`，`childStage`、`childRunning` 都从它派生，`TaskStatusIcon` 传 `icon={childIcon(c)}`，不按 `status + working` 各算；侧栏橙点读 `taskDoneDot`（完成、非当前打开才画），不和转圈共存。
- 规则：对话停在「等待你的下一条消息」时 `status` 仍是 `running`，合并、删除、切分支、AI 分析、回复完才显示的卡片都看 `task.working`；服务端用 `live.get(id)?.task.working`，不用 `live.has(id)`。
- 起因：分组、图标、计数、标题 `(n)` 各算一套，已完成不显示对勾、已解决画成暂停；独立分支条和 AI 分析菜单按 `status` 判断，做完的没有合并按钮；橙点不看状态，和转圈同在一行。
- 防线：`shared/task-stage.test.ts` 的一致性用例、`web/src/lib/title-count.test.ts`、`scripts/e2e.mjs`、`scripts/rules-check.mjs`。

## 行内代码里的文件路径按段校验，字符集用 Unicode 属性

- 规则：认行内代码是不是文件路径用 `web/src/lib/file-path.ts` 的 `parsePath` / `linkPaths`，别另写正则；字符集用 `\p{L}\p{N}`（带 `u`），不用 `\w`（只认 ASCII）；扩展名白名单带图片格式；不误判靠「按段校验 + 白名单 + 拒绝 URL 和命令参数」，不收紧字符集。
- 起因：`ui-shots/107-对话-图片气泡.png` 这类中文路径点不开。
- 防线：`web/src/lib/file-path.test.ts`、`scripts/ui-check.mjs` 的「对话-路径可点」。
