# Agent 面板 · 开发约定

给在这个仓库里工作的 AI 编码助手（Codex、Claude Code、Command Code 等）和开发者看。`CLAUDE.md` 只是引用本文件，规则只改这一份。

这份文件每次对话都会读，只放所有改动都适用的规则；具体领域的做法在下面「文档地图」里，用到再读。

## 开工前

1. **切到 `dev`**：`git switch dev`（本地没有就 `git switch -c dev origin/dev`），`git status --short --branch` 确认在 `dev` 上再动手。
2. **查教训**：想好要改哪些文件，跑 `node scripts/lessons.mjs <文件...>`，只输出和这些文件相关的踩坑记录；拿不准就 `--list` 看标题。
3. **读专题文档**：按下面的文档地图，只读这次用得上的。

## 项目

本机运行的网页控制台，按项目调度本机的编码 CLI（Claude Code、Codex、Command Code、Gemini CLI、Pi），按工作流的流程图执行。

- 全部 TypeScript，不用 Python：前端 `web/`（React 19 + Vite + Tailwind v4 + Radix UI + @xyflow/react），
  服务端 `server/`（Hono，只监听 127.0.0.1），前后端共用的结构和逻辑在 `shared/`（zod schema、流程图、执行引擎）。
- 用户数据是数据目录（默认 `~/.agent-panel`）下的 JSON 文件。
- 在线演示（`vite build --mode demo`）把 API 换成浏览器里的模拟实现（`web/src/lib/demo-*.ts`），正式包里不能有这些内容。
- 自带 Skill 在 `skills/`，内置角色和工作流模板在 `shared/builtin/`，浏览器扩展在 `extension/`。

## 硬规则

- **CLI 的差异写进 CLI 定义**（`shared/clis.ts`、`shared/clis/*.json`），代码按定义里的字段走，不按 CLI 的名字写分支（`scripts/rules-check.mjs` 会拦）。
- **界面文案用 `t('中文原文')`**，英文同一个提交写进 `shared/locales/en/`；漏翻 `npm run typecheck` 会失败。发给 Agent 的提示词、注释、演示数据不翻译。
- **界面参考 Claude Code 的风格，视觉质量很重要**。界面细则见 `docs/lessons/ui.md`。
- 注释用中文，写「为什么」。`useEffect` 故意少写依赖时，在依赖数组上一行写明原因再加 `// oxlint-disable-next-line react-hooks/exhaustive-deps`。
- Agent 执行出的错误一律显示给用户，不悄悄重试。
- **凭据不进仓库**：密码、令牌、API key 只放本机数据目录（默认 `~/.agent-panel`）或环境变量，不写进代码、测试、fixtures、文档和提交说明；示例只用 `sk-xxxx`、`your-api-key` 这类占位符。`npm run lint` 会跑 `scripts/secret-check.mjs` 扫描全仓和暂存区，发现疑似真实 key 直接失败；确实要保留的行在结尾加 `secret-check-ok` 并写明原因。
- **贡献流程与漏洞报告**：怎么提改动、跑哪些检查见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题按 [SECURITY.md](SECURITY.md) 私下报告，不开公开 Issue。
- **模块文档**：模块说明只放 `docs/modules/<模块>/README.md`（Bug 记录在同目录 `bugs.md`）。调研某个模块时先查 `docs/MODULE-MAP.md` 和对应模块文档，有就先读再查；结论回写模块文档，已有就合并不覆盖，模块在代码里没了就删目录并同步 `MODULE-MAP.md` 的表格行。细则见 [skills/docs/project-documentation](skills/docs/project-documentation/SKILL.md)。

## 文档地图

| 要做的事                                     | 先读                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| 文档入口、快速开始、文档索引                 | [docs/README.md](docs/README.md)                                                       |
| 改动该放哪个模块、模块之间怎么依赖           | [docs/MODULE-MAP.md](docs/MODULE-MAP.md)，模块细则在 `docs/modules/`                   |
| 模块文档的先读、合并与删除                   | [skills/docs/project-documentation](skills/docs/project-documentation/SKILL.md)        |
| 接新 CLI、改参数 / 输出解析 / 思考强度 / API | [docs/cli-config.md](docs/cli-config.md)（开头有接入检查清单）                         |
| 模型的上下文、最大输出、强度                 | [docs/model-catalog.md](docs/model-catalog.md)                                         |
| 增删合并内置角色或工作流                     | [docs/agent-catalog.md](docs/agent-catalog.md)（判定标准）                             |
| 测试步骤、角色参数、子对话隔离和合并编译     | [docs/agent-test-steps.md](docs/agent-test-steps.md)                                   |
| 自带 Skill                                   | [skills/README.md](skills/README.md)                                                   |
| UI 设计导出格式                              | [docs/umg-export.md](docs/umg-export.md)                                               |
| CLI 输出样本                                 | [server/exec/fixtures/README.md](server/exec/fixtures/README.md)                       |
| 踩过的坑、怎么记新的                         | [docs/lessons/README.md](docs/lessons/README.md)，平时用 `node scripts/lessons.mjs` 取 |
| 写架构决策、查为什么这么定（ADR）            | [docs/adr/README.md](docs/adr/README.md)（什么时候写、命名和正文各节）                 |

## 常用命令

```bash
npm run dev          # 前端 :5173 + 后端 :8787
npm run typecheck    # 类型检查 + 漏翻检查
npm run lint         # oxlint、Prettier 格式检查、规则检查（scripts/rules-check.mjs）
npm run test:unit    # 单元测试和 CLI 输出解析测试
npm run test:e2e     # 端到端测试（用 scripts/fake-cli 模拟各个 CLI）
node scripts/ui-check.mjs   # 界面检查：先 vite build --mode demo，分片在 scripts/ui/ 并行跑，截图在 ui-shots/
npm run build        # 正式版前端
npx vite build --mode demo   # 在线演示版
npm run package      # 出包到 release/（正式版，不含演示内容）
npx prettier --write <文件>  # 格式化（配置在 .prettierrc.json）
```

在 Windows 上测试时，端到端测试放到本机的 WSL（Ubuntu 24.04）里运行，不在 Windows 本机直接跑。

## 提交前

以前反复返工的几件事，提交前过一遍：

1. `git status --short` 看清楚要提交的文件：新文件都 add 了，测试或 CLI 留下的临时输出没混进来。
2. `npm run typecheck && npm run lint` 通过（格式问题 `npx prettier --write` 改掉，别留给下一个提交）。
3. 改了提示词或文案，搜一下测试里有没有断言原句；动了执行流程，跑 `npm run test:e2e`。
4. `node scripts/lessons.mjs` 对照这次改动的相关教训。

## 被纠正之后

用户纠正了做法、或者你在修之前（自己或别的 AI）改出来的问题时，在同一个提交里把教训写进 `docs/lessons/` 对应的分片：
写成下次能直接照做的通用规则，附上起因的提交号。能写成检查的，加进 `scripts/rules-check.mjs` 或测试，文档里只留一行指针。
格式和取舍见 [docs/lessons/README.md](docs/lessons/README.md)。

## 分支与发布

- **开发前必须先切换到 `dev` 分支**：开始任何代码、文档或配置改动之前，先跑 `git switch dev`（本地没有就用 `git switch -c dev origin/dev`），确认 `git status --short --branch` 显示在 `dev` 上再动手。
- **禁止在 `main` 上直接开发**：不在 `main` 上改文件、提交或推送，包括小改动、文档修改和临时调试。误留在 `main` 时先切回 `dev`，不要在 `main` 上先改完再搬。
- 如果在 `main` 上发现未提交改动，先确认这些改动是谁的、要不要带走；不要用 `git checkout .`、`git reset --hard` 或覆盖式 stash 把它们清掉。
- **所有开发都在 `dev` 分支上进行**，提交并推送到 `dev`。多个助手可能同时往 `dev` 推，推送前先 `git pull --rebase origin dev`。
- **只有用户明确说「合并到主干」时，才把 `dev` 合并到 `main`**。不要自行合并，也不要直接往 `main` 提交。
- 推送到 `dev` 运行「检查」（`.github/workflows/ci.yml`）：类型检查、代码检查、解析测试、端到端测试、构建、界面检查；合并到 `main` 运行「出包」（`.github/workflows/release.yml`），先跑同样的检查再出包。
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
- 用户感受不到的改动（开发文档、教训、测试、格式、误提交的临时文件）标题以 `内部：` 开头，不进更新说明；
  同一个提交里还有用户能感受到的改动时，那几行照常写前缀，`内部：` 的行会被跳过。
- 说明写给用户看：讲用户能感受到的变化，不写内部实现细节。
