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

## 界面上配置的 Agent 叫「角色」，编码工具叫「Agent」

- 规则：配置出来的 Agent（角色设定 + CLI + 模型）在界面上写「角色」（2dbcf97）；编码工具本身（Claude Code、Codex、Pi…）在界面上写「Agent」，不写「CLI」，例如「默认 Agent」「本机 Agent」。「Gemini CLI」这类产品名、给开发者看的说明（CLI 定义、配置字段）照旧写 CLI。代码里的类型名、变量名不改。
- 起因：用户问设置里的「默认 CLI」能不能叫 Agent，角色改名后 Agent 这个词空出来了。
- 防线：人工。

## 视觉改动自己先截图看一遍

- 规则：改了布局、弹窗、列表就跑 `node scripts/ui-check.mjs`，到 `ui-shots/` 看深浅两套主题；对照 Claude Code 的风格。用户会逐个指出小瑕疵，自己先挑掉。
- 防线：`scripts/ui-check.mjs`（只检查文案在不在，不看好不好看）。
