# Agent 面板 · 开发约定

给在这个仓库里工作的 AI 编码助手（Codex、Claude Code 等）和开发者看。`CLAUDE.md` 与本文件内容保持一致，改一个就同步改另一个。

## 项目

本机运行的网页控制台，按项目分类调度本机的编码 CLI（Claude Code、Codex、Command Code），按工作流的流程图执行。

- 全部 TypeScript：前端 `web/`（React 19 + Vite + Tailwind v4 + Radix UI + @xyflow/react），服务端 `server/`（Hono，只监听 127.0.0.1），
  前后端共用的结构和逻辑在 `shared/`（zod schema、流程图、执行引擎）。不用 Python。
- 数据是 `data/` 下的 JSON 文件。
- 在线演示（`vite build --mode demo`）把 API 换成浏览器里的模拟实现 `web/src/lib/demo-backend.ts`、`demo-assist.ts`。
- 界面参考 Claude Code 的风格，视觉质量很重要。
- 界面支持中文和英文：文案用 `t('中文原文')`（`shared/i18n.ts`，中文原文就是键，插值写 `t('共 {n} 个', { n })`），
  英文写在 `shared/locales/en/` 下对应的文件里。`npm run typecheck` 会跑 `scripts/i18n-check.mjs`，有漏翻的就失败。
  发给 Agent 的提示词、注释、演示数据不翻译。

## 常用命令

```bash
npm run dev          # 前端 :5173 + 后端 :8787
npm run typecheck    # 类型检查
npm run test:unit    # CLI 输出解析测试（样本在 server/exec/fixtures/，CLI 升级后重新录）
npm run test:e2e     # 端到端测试（用 scripts/fake-cli 模拟三个 CLI）
npm run build        # 正式版前端
npx vite build --mode demo   # 在线演示版
npm run package      # 出包到 release/（正式版，不含演示内容）
```

代码格式：`npx prettier --no-semi --single-quote --print-width 120 --write <文件>`。注释用中文，写「为什么」。

## 分支与发布

- **所有开发都在 `dev` 分支上进行**，提交并推送到 `dev`。
- **只有用户明确说「合并到主干」时，才把 `dev` 合并到 `main`**。不要自行合并，也不要直接往 `main` 提交。
- 推送到 `dev` 运行「检查」（`.github/workflows/ci.yml`）：类型检查、解析测试、端到端测试、构建；合并到 `main` 运行「出包」（`.github/workflows/release.yml`），先跑同样的检查再出包。
  - 推送到 `dev`：**只检查，不出包**，不会出现出包的步骤。
  - 合并到 `main`：检查通过后出包，发布正式版（Latest）到 GitHub Releases，标签 `v<主>.<次>.<提交数>`
  - 包由 `scripts/package.mjs` 生成：正式版前端 + 打成单文件的服务端 `server.mjs` + 启动脚本，解压后只需要 Node.js 20+。
    **包里不能有演示内容**（脚本会检查，混进去就失败）。
  - 主、次版本号取 `package.json` 的 `version`；有较大的功能变化时提升次版本号。
- 在线演示（GitHub Pages，https://fixcode-h.github.io/agent-panel/ ）部署的是 **`dev` 分支**的内容，dev 检查通过后自动更新。
- 只推送到 `fixcode-h/agent-panel`。

## 提交说明（会写进 Release 的更新说明）

Release 的说明由 `scripts/release-notes.mjs` 从上一个同类版本以来的提交里整理，格式参照常见的「新功能 / 改进与调整 / Bug 修复 / 依赖升级 / 下载」。
提交说明的标题概括这次改动，正文每条改动一行，用下面的前缀分类，写成「标题 — 说明」，标题会加粗：

```
流程图支持拖线新建节点，修复设置弹窗闪动

新功能：拖线新建节点 — 从节点拖线到空白处松手，弹出菜单新建节点并自动连上
修复：设置弹窗打开位置 — 打开时不再先出现在左上角再跳到中间
改进：下拉框样式 — 所有下拉框换成跟随主题的列表
```

- 前缀：`新功能：`、`改进：`、`修复：`、`依赖：`。依赖版本变化会从 `package.json` 自动整理，一般不用手写。
- 没有前缀的提交，标题会作为一条「改进与调整」。
- 说明写给用户看：讲用户能感受到的变化，不写内部实现细节。
