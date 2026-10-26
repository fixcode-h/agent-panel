---
paths: web/src/**, shared/i18n.ts, shared/locales/**, shared/task.ts, scripts/ui-check.mjs, scripts/ui/**
---

# 界面、文案和样式

## 文案、命名和控件的写法

- 规则：界面文案（含服务端返回给界面的报错）都走 `t()`，英文写进 `shared/locales/en/`；提示词、注释、演示数据不翻。
- 规则：字号用 rem（`text-[0.8125rem]`，不写 `text-[13px]`），设置里「字号」改根字号；字体用 `--app-sans` / `--app-mono`（`web/src/lib/appearance.ts`）；基础样式放 `@layer base`，否则盖掉工具类。单个字形难看就用同家族 `@font-face` + `unicode-range` 只换那个字符（`web/src/maple-mono.css`）。
- 规则：配置出来的 Agent（角色设定 + CLI + 模型）界面写「角色」（2dbcf97），编码工具本身（Claude Code、Pi…）写「Agent」，如「默认 Agent」；产品名和开发者说明照旧写 CLI，代码里的类型名、变量名不改。
- 规则：不列「默认」「自动」「CLI 默认」选项，直接预选并标「（默认）」；思考强度写 `english · 中文`，只列当前模型支持的档位、按 CLI 顺序，存的值不支持时用 `effortValue` / `defaultEffortOptions` 取最接近的，不补进下拉；停用/没装的 CLI 不出现在选择器和列表里；名字叫「Codex」不叫「Codex CLI」。
- 起因：v0.18 思考强度排序被指出（medium 排在 off 前）；「默认 CLI」改名 Agent。
- 防线：`npm run typecheck`（`scripts/i18n-check.mjs`）、`web/src/lib/cli-style.test.ts`；改了布局、弹窗、列表跑 `scripts/ui-check.mjs`，到 `ui-shots/` 看深浅两套主题。

## 拖引用、条目点法和弹窗取数

- 规则：文件拖进输入框用左键长按（`fileDrag.ts` 的 `longPressed`，约 300ms），右键留给菜单；拖完压掉补发的 click。
- 规则：一行一个的条目（工具调用、子任务、面板结果、提问）用 `RowShell`：只有中间标题打开窗口，动作名、结果、箭头是展开收起；没有窗口的条目点哪里都展开收起，不整行做成打开按钮。`detailStart`（详情左对齐）只给没有展开收起、详情只是说明的行用：详情区不吃点击，标题与详情之间留间距或分隔线，别做成两个相邻点击目标。
- 规则：会被角色或后台改动的数据（如项目教训）别只用页面缓存，弹窗打开时重新请求合进草稿，否则 `record_lesson` 记的教训在项目设置里看不到。
- 起因：拖引用原来做成右键拖动、子任务一行点哪里都开弹窗；运行区子对话行左对齐后标题和状态糊成一块。
- 防线：`scripts/ui-check.mjs` 的「任务-长按拖入引用」。

## 面板的产物不冒充用户、不另起居中提示

- 规则：面板推给 CLI 的内容（后台命令、合并编译、子任务结果）记成 `TaskMessage.panel`，画成 AI 回复里的一行；面板工具调用按「做了什么 + 对象名」显示（`toolView` / `panelTool`，新加的工具要进 `PANEL_TOOL`），不另记居中提示，也不插提示把回复截成两段。子对话汇报只给父对话 AI，提问是父对话的卡片（`panel: 'child'` / `'ask'`）。
- 起因：15c1a1d 把后台命令结果当用户消息推回、新建子对话另记居中提示；之后「要改文件了…」截断回复。
- 防线：`server/orch-mcp.test.ts`、`server/orchestrator.test.ts`、`scripts/e2e.mjs`（开分支不记提示、提问卡片）。

## 一个状态只允许一处判定：childIcon、working 和橙点

- 规则：子对话/任务展示只读 `shared/task.ts` 的 `childIcon(entry)`，`childStage`、`childRunning` 都从它派生，`TaskStatusIcon` 传 `icon={childIcon(c)}`，不按 `status + working` 各算；侧栏橙点读 `taskDoneDot`（完成、非当前打开才画），不和转圈共存。
- 规则：对话停在「等待你的下一条消息」时 `status` 仍是 `running`，合并、删除、切分支、AI 分析、回复完才显示的卡片都看 `task.working`；服务端用 `live.get(id)?.task.working`，不用 `live.has(id)`。
- 起因：分组、图标、计数、标题 `(n)` 各算一套，已完成不显示对勾、已解决画成暂停；独立分支条和 AI 分析菜单按 `status` 判断，做完的对话没有合并按钮；橙点不看完成态，和转圈同在一行。
- 防线：`shared/task-stage.test.ts` 的一致性用例、`web/src/lib/title-count.test.ts`、`scripts/e2e.mjs`、`scripts/rules-check.mjs`。

## 行内代码里的文件路径按段校验，字符集用 Unicode 属性

- 规则：判断行内代码是不是文件路径用 `web/src/lib/file-path.ts` 的 `parsePath` / `linkPaths`，别另写正则；字符集用 `\p{L}\p{N}`（带 `u`），不用 `\w`（只认 ASCII）；扩展名白名单带图片格式；不误判靠「按段校验 + 白名单 + 拒绝 URL 和命令加参数」，不收紧字符集。
- 起因：`ui-shots/107-对话-图片气泡.png` 这类中文路径点不开。
- 防线：`web/src/lib/file-path.test.ts`、`scripts/ui-check.mjs` 的「对话-路径可点」。

## 输入框不能被外面重渲染重画或重挂载

- 规则：`RichInput` 整棵重画（`paint` → `replaceChildren`）只在文字真变了时做：上传完成只换卡片里的 `img`（`updatePreviews`）；重画会擦掉组合中的字，组合期间（`compositionstart` → `compositionend`）跳过的等结束后补。卡片操作点击时重新取 `actions()`，别闭包捕获画卡片那刻的 `files`。
- 规则（重渲染）：输入框用 `draftKey` 自管草稿（`ChatComposer` 的 `useDraft`），打字只重渲染输入框；消息列表按 `memo` 比，`slot` 这类新画的 ReactNode 用内容签名 `slotKey`；格式化复用 `Intl`，别每次 new。
- 起因：用户反馈实时输出时打字卡、输入框失焦；实测 `Intl` 每次新建占 109ms/3s，`slot` 的 memo 从未命中。
- 防线：`scripts/ui-check.mjs`（推送期间输入框不重挂载、不丢焦点；行内图片卡片上传后还能删除）。
