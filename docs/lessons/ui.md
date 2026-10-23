---
paths: web/src/**, shared/i18n.ts, shared/locales/**, shared/task.ts, scripts/ui-check.mjs
---

# 界面、文案和样式

## 文案走 t('中文原文')，字号用 rem、字体走变量

- 规则：界面文案（含服务端返回给界面的报错）都走 `t()`，英文写进 `shared/locales/en/` 对应文件；提示词、注释、演示数据不翻。
- 规则：`text-[0.8125rem]` 而不是 `text-[13px]`；设置里的「字号」改根字号，写死像素就不跟着变。字体用 `--app-sans` / `--app-mono`（`web/src/lib/appearance.ts`）。基础样式放在 `@layer base` 里，否则会盖掉 Tailwind 的工具类。单个字形难看（Maple Mono NL 的 @ 像图标叠字）就用同家族 `@font-face` + `unicode-range` 只换那个字符（`web/src/maple-mono.css`）。
- 规则：改了布局、弹窗、列表跑 `node scripts/ui-check.mjs`，到 `ui-shots/` 看深浅两套主题、对照 Claude Code 风格，先挑掉瑕疵。
- 防线：`npm run typecheck`（`scripts/i18n-check.mjs`）；`scripts/ui-check.mjs` 只查文案，字号字体人工。

## 文件树拖引用用左键长按

- 规则：文件拖进输入框用左键长按（`fileDrag.ts` 的 `longPressed`，约 300ms），右键留给菜单；拖完压掉浏览器补发的 click，否则顺手打开文件。
- 起因：原来做成右键按住拖动，用户要求改成左键长按。
- 防线：`scripts/ui-check.mjs` 的「任务-长按拖入引用」。

## 下拉框和选择器的固定写法

- 规则：不单独列「默认」「自动」「CLI 默认」选项，直接预选默认值并在后面标「（默认）」；思考强度标签写 `english · 中文`；停用或没装的 CLI 不出现在任何选择器和列表里；名字叫「Codex」不叫「Codex CLI」。
- 起因：用户多次指出（v0.18 前后），medium 排在 off 前面。
- 思考强度下拉只列当前模型支持的档位，按 CLI 的档位顺序；默认值或存着的值模型不支持时用 `effortValue` / `defaultEffortOptions` 换成最接近的那档，不把它补进下拉。
- 防线：`web/src/lib/cli-style.test.ts`；其余人工。

## 界面上配置的 Agent 叫「角色」，编码工具叫「Agent」

- 规则：配置出来的 Agent（角色设定 + CLI + 模型）在界面上写「角色」（2dbcf97）；编码工具本身（Claude Code、Codex、Pi…）写「Agent」，不写「CLI」，例如「默认 Agent」。「Gemini CLI」这类产品名、给开发者看的说明（CLI 定义、配置字段）照旧写 CLI。代码里的类型名、变量名不改。
- 起因：用户问设置里的「默认 CLI」能不能叫 Agent，角色改名后 Agent 这个词空出来了。
- 防线：人工。

## 面板的产物不冒充用户、不另起居中提示

- 规则：面板推给 CLI 的内容（后台命令、合并编译、子任务结果）记成 `TaskMessage.panel` 的系统消息，界面画成 AI 回复里的一行；面板工具调用按「做了什么 + 对象名」显示（`toolView` / `panelTool`，新加的面板工具要加进 `PANEL_TOOL`），不再另记居中的系统提示。AI 执行中途（包括开独立分支后换会话接着做）不能插居中提示把一段回复截成两段。子对话的汇报只交给父对话的 AI（`panel: 'child'`），提问是父对话里的卡片（`panel: 'ask'`）。
- 起因：15c1a1d 把后台命令结果当用户消息推回、新建子对话另记一条居中提示；之后「要改文件了…」截断回复、子对话汇报铺满一屏，用户再次指出。
- 防线：`server/orch-mcp.test.ts`、`server/orchestrator.test.ts`、`scripts/e2e.mjs`（开分支不记提示、提问卡片）。

## 一个状态只允许一处判定：图标、分组、计数、徽标都读它

- 规则：子对话 / 任务的展示只读 `shared/task.ts` 的 `childIcon(entry)`：`childStage`、`childRunning`、`childSpinning`、`childWaiting`、`taskBusy` 都由它派生，`TaskStatusIcon` 传 `icon={childIcon(c)}`，不按 `status + working` 各算一遍。
- 起因：分组、图标、计数、标题 `(n)` 各算一套，出现「已完成组里的项不显示对勾」「已解决的项画成暂停」。用户连问三次。
- 防线：`shared/task-stage.test.ts` 的一致性用例、`web/src/lib/title-count.test.ts`。

## 「对话在不在动手」看 working，不看 status

- 规则：对话停在「等待你的下一条消息」时 `status` 仍是 `running`（CLI 进程还在），能不能合并、删除、切分支、AI 分析这类操作，以及「回复完才显示」的卡片，都要看 `task.working`；服务端对应用 `live.get(id)?.task.working`，不要用 `live.has(id)`。
- 起因：独立分支条按 `status === 'running'` 隐藏合并按钮，对话做完了也合并不了，用户问「对话完成了为什么没有合并按钮」；后来「AI 分析执行结果」菜单和分析结果卡片又按 `status` 判断，用户问「对话结束了为啥还不可以 AI 分析」。
- 防线：`scripts/e2e.mjs` 的独立分支用例。

## 工具条目统一点法

- 规则：对话里一行一个的条目（工具调用、子任务、面板结果、提问）用 `RowShell`：只有中间标题文字打开窗口，动作名和后面的结果、箭头是展开收起；没有窗口的条目点哪里都展开收起。不要整行做成打开窗口的按钮。
- 起因：用户指出子任务一行点哪里都开弹窗，要求统一（人工）。

## 弹窗里显示的服务端数据，打开时重新取

- 规则：会被角色或后台改动的数据（如项目教训）别只用页面缓存，弹窗打开时重新请求再合进草稿。
- 起因：角色用 `record_lesson` 记的教训，项目设置里看不到。
- 防线：人工。

## 行内代码里的文件路径按段校验，字符集用 Unicode 属性

- 规则：认「这段行内代码是不是文件路径」用 `web/src/lib/file-path.ts` 的 `parsePath` / `linkPaths`，别再在原地写正则。字符集用 `\p{L}\p{N}`（带 `u`），不能用 `\w`（只认 ASCII，中文名整条漏掉）；扩展名白名单要带图片格式（png/jpg/jpeg/gif/webp/bmp），不误判靠「按段校验 + 扩展名白名单 + 显式拒绝 URL 和命令加参数」，不要靠收紧字符集。
- 起因：消息里 `ui-shots/107-对话-图片气泡.png` 这类中文路径点不开，`\w` 不匹配中文、`EXT` 里也没有图片扩展名。
- 防线：`web/src/lib/file-path.test.ts`（`console.log`、`a.b`、`1.2.3`、URL、`node scripts/e2e.mjs` 仍不匹配）、`scripts/ui-check.mjs` 的「对话-路径可点」。

## 输入框不能被外面重渲染重画或重挂载

- 规则：`RichInput` 整棵重画（`paint` → `replaceChildren`）只在文字真变了时做：上传完成只换卡片里的 `img`（`updatePreviews`），重画会擦掉输入法组合里的字、光标要靠重设选区恢复；组合期间（`compositionstart` → `compositionend`）跳过的重画等结束后补。卡片操作点击时重新取 `actions()`，别闭包捕获画卡片那刻的 `files`，否则上传完成前的卡片拿不到新附件。
- 规则（重渲染）：对话页输入框用 `draftKey` 自管草稿（`ChatComposer` 的 `useDraft`），打字只重渲染输入框；消息列表按 `memo` 比，`slot` 这类每次新画的 ReactNode 用内容签名 `slotKey` 比；每次渲染都调的格式化复用 `Intl` 实例，别每次 new。
- 起因：用户反馈实时输出时打字卡、输入框偶尔失焦；实测一次提交 76ms、3 秒 14 个 longtask，`formatAt` 新建 `Intl` 占 109ms/3s、`slot` 的 memo 从未命中。
- 防线：`scripts/ui-check.mjs`（推送期间输入框不重挂载、不丢焦点；行内图片卡片上传后还能删除）。
