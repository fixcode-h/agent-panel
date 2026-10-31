---
paths: web/src/**, shared/i18n.ts, shared/locales/**, shared/task.ts
---

# 界面通用：文案、命名和状态判定

只放所有界面代码都适用的规则；只和某个模块有关的放进对应分片（输入框 [composer.md](./composer.md)、对话消息 [messages.md](./messages.md)、视觉 [visual.md](./visual.md)、界面检查 [ui-check.md](./ui-check.md)）。

## 文案、命名和控件的写法

- 规则：界面文案（含服务端返回给界面的报错）都走 `t()`，英文写进 `shared/locales/en/`；提示词、注释、演示数据不翻。
- 规则：字号用 `index.css` `@theme` 里的字号角色（`text-caption` / `text-body` / `text-prose`…），不手写 `text-[…rem]`；圆角用 `rounded-sm/lg/xl/2xl/3xl` 五级阶梯，不手写 5px 以上的 `rounded-[…]`（原来散着 20 多种字号、十几种圆角，相邻差半像素，由 `scripts/rules-check.mjs` 第 6c 条拦）。字体用 `--app-sans` / `--app-mono`；基础样式放 `@layer base`；单个字形难看用 `@font-face` + `unicode-range` 只换它（`web/src/maple-mono.css`）。
- 规则：配置出来的 Agent（角色设定 + CLI + 模型）界面写「角色」（2dbcf97），编码工具本身（Claude Code、Pi…）写「Agent」，如「默认 Agent」；产品名和开发者说明写 CLI，代码里的类型名、变量名不改。
- 规则：不列「默认」「自动」，直接预选并标「（默认）」；思考强度写 `english · 中文`，只列当前模型支持的档位、按 CLI 顺序，不支持的值用 `effortValue` 取最接近的；停用/没装的 CLI 不出现；叫「Codex」不叫「Codex CLI」。
- 起因：v0.18 思考强度排序被指出（medium 排在 off 前）；「默认 CLI」改名 Agent。
- 防线：`npm run typecheck`（`scripts/i18n-check.mjs`）、`web/src/lib/cli-style.test.ts`；改了布局、弹窗、列表跑 `scripts/ui-check.mjs`，到 `ui-shots/` 看深浅两套主题。

## 一个状态只允许一处判定：childIcon、working 和橙点

- 规则：子对话/任务展示只读 `shared/task.ts` 的 `childIcon(entry)`，`childStage`、`childRunning` 都从它派生，`TaskStatusIcon` 传 `icon={childIcon(c)}`，不按 `status + working` 各算；侧栏橙点读 `taskDoneDot`（完成、非当前打开才画），不和转圈共存。
- 规则：对话停在「等待你的下一条消息」时 `status` 仍是 `running`，合并、删除、切分支、AI 分析、回复完才显示的卡片都看 `task.working`；服务端用 `live.get(id)?.task.working`，不用 `live.has(id)`。
- 起因：分组、图标、计数、标题 `(n)` 各算一套，已完成不显示对勾、已解决画成暂停；独立分支条和 AI 分析菜单按 `status` 判断，做完的没有合并按钮；橙点不看状态，和转圈同在一行。
- 防线：`shared/task-stage.test.ts` 的一致性用例、`web/src/lib/title-count.test.ts`、`scripts/e2e.mjs`、`scripts/rules-check.mjs`。
