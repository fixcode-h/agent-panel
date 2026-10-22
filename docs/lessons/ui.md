---
paths: web/src/**, shared/i18n.ts, shared/locales/**, scripts/ui-check.mjs
---

# 界面、文案和样式

## 新文案用 t('中文原文')，英文同一个提交补上

- 规则：界面文案（含服务端返回给界面的报错）都走 `t()`，英文写进 `shared/locales/en/` 对应文件；提示词、注释、演示数据不翻。
- 防线：`npm run typecheck`（`scripts/i18n-check.mjs`）。

## 字号用 rem，字体走变量

- 规则：`text-[0.8125rem]` 而不是 `text-[13px]`；设置里的「字号」改根字号，写死像素就不跟着变。字体用 `--app-sans` / `--app-mono`（`web/src/lib/appearance.ts`）。基础样式放在 `@layer base` 里，否则会盖掉 Tailwind 的工具类。
- 防线：人工。

## 下拉框和选择器的固定写法

- 规则：不单独列「默认」「自动」「CLI 默认」选项，直接预选默认值并在后面标「（默认）」；思考强度标签写 `english · 中文`；停用或没装的 CLI 不出现在任何选择器和列表里；名字叫「Codex」不叫「Codex CLI」。
- 起因：用户多次指出（v0.18 前后）。
- 思考强度下拉只列当前模型支持的档位，按 CLI 的档位顺序；默认值或存着的值模型不支持时用 `effortValue` / `defaultEffortOptions` 换成最接近的那档，不把它补进下拉（用户指出中档的 medium 排在 off 前面）。
- 防线：`web/src/lib/cli-style.test.ts`；其余人工。

## 界面上配置的 Agent 叫「角色」，编码工具叫「Agent」

- 规则：配置出来的 Agent（角色设定 + CLI + 模型）在界面上写「角色」（2dbcf97）；编码工具本身（Claude Code、Codex、Pi…）在界面上写「Agent」，不写「CLI」，例如「默认 Agent」「本机 Agent」。「Gemini CLI」这类产品名、给开发者看的说明（CLI 定义、配置字段）照旧写 CLI。代码里的类型名、变量名不改。
- 起因：用户问设置里的「默认 CLI」能不能叫 Agent，角色改名后 Agent 这个词空出来了。
- 防线：人工。

## 视觉改动自己先截图看一遍

- 规则：改了布局、弹窗、列表就跑 `node scripts/ui-check.mjs`，到 `ui-shots/` 看深浅两套主题；对照 Claude Code 的风格。用户会逐个指出小瑕疵，自己先挑掉。
- 防线：`scripts/ui-check.mjs`（只检查文案在不在，不看好不好看）。

## 面板自己产生的东西不冒充用户、不另起居中提示

- 规则：面板推给 CLI 的内容（后台命令、合并编译、子任务结果）记成 `TaskMessage.panel` 的系统消息，界面画成 AI 回复里的一行；面板工具调用按「做了什么 + 对象名」显示（`toolView` / `panelTool`，新加的面板工具要加进 `PANEL_TOOL`），不再另记居中的系统提示。AI 执行中途（包括开独立分支后换会话接着做）不能插居中提示把一段回复截成两段。子对话的汇报只交给父对话的 AI（`panel: 'child'`），提问是父对话里的卡片（`panel: 'ask'`）。
- 起因：15c1a1d 把后台命令结果当用户消息推回，新建子对话又多记一条居中提示，用户要求改成工具条目；之后「要改文件了，已开独立分支…」截断了 AI 的回复，子对话的汇报、提问在父对话里居中铺满一屏，用户再次指出。
- 防线：`server/orch-mcp.test.ts`、`server/orchestrator.test.ts`、`scripts/e2e.mjs`（开分支不记提示、提问卡片）。

## 「对话在不在动手」看 working，不看 status

- 规则：对话停在「等待你的下一条消息」时 `status` 仍是 `running`（CLI 进程还在），能不能合并、删除、切分支、AI 分析这类操作，以及「回复完才显示」的卡片，都要看 `task.working`；服务端对应用 `live.get(id)?.task.working`，不要用 `live.has(id)`。
- 起因：独立分支条按 `status === 'running'` 隐藏合并按钮，对话做完了也合并不了，用户问「对话完成了为什么没有合并按钮」；后来「AI 分析执行结果」菜单和分析结果卡片又按 `status` 判断，用户问「对话结束了为啥还不可以 AI 分析」。
- 防线：`scripts/e2e.mjs` 的独立分支用例。

## 工具条目统一点法

- 规则：对话里一行一个的条目（工具调用、子任务、面板结果、子对话提问）都用 `RowShell`：只有中间的标题文字打开窗口（命令行、差异、文件、子任务、子对话），前面的动作名和后面的结果、箭头是展开收起；没有窗口的条目点哪里都是展开收起。新加这类条目照着用，不要整行做成一个打开窗口的按钮。
- 起因：用户指出子任务一行点哪里都开弹窗，要求和所有类似的调用统一。
- 防线：人工。
