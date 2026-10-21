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
- 防线：人工。

## 界面上 Agent 叫「角色」

- 规则：除了产品名、「Agent 模式」和「让 CLI 以 Agent 身份做事」这类说法，界面文案里的 Agent 都写「角色」（2dbcf97）。代码里的类型名不改。
- 防线：人工。

## 视觉改动自己先截图看一遍

- 规则：改了布局、弹窗、列表就跑 `node scripts/ui-check.mjs`，到 `ui-shots/` 看深浅两套主题；对照 Claude Code 的风格。用户会逐个指出小瑕疵，自己先挑掉。
- 防线：`scripts/ui-check.mjs`（只检查文案在不在，不看好不好看）。
