# Agent 面板

一个跑在本机的网页控制台：按项目分类，调度本机的编码 Agent（Claude Code、Codex CLI、Command Code），
由主 Agent 和子 Agent 按工作流的流程图执行：连线决定先后，没有先后关系的节点同时执行，节点可以挂载验收流程，不通过就退回修改。
界面参考 Claude Code。

**在线预览：https://fixcode-h.github.io/agent-panel/** （展示 dev 分支的最新内容；预览版在浏览器里模拟执行，不调用 CLI）

**下载：[Releases](https://github.com/fixcode-h/agent-panel/releases)** 。正式版来自 main，预览版来自 dev；解压后只需要 Node.js 20+，Windows 双击 `start.cmd`，macOS / Linux 运行 `./start.sh`。

- **Agent**：每个 Agent 是「CLI + 模型 + 角色设定」的组合，按分类管理；自动检测本机 CLI，预览实际执行的命令。
  CLI 可以选「系统默认」，模型可以只选高 / 中 / 低档，执行时按设置换成具体的 CLI、模型和思考强度，改设置就能整体切换；
  也可以单独指定思考强度
- **工作流**：选一个主 Agent 和若干子 Agent 组成团队，在流程图里自由编排：
  - 节点随意拖动摆放，从节点右侧的圆点拖线到另一个节点表示先后；新建节点不会自动连线，没连上的节点不执行。
    一个节点的上游全部完成后它才开始，没有先后关系的节点同时执行，不能连成环
  - 一个工作流可以有多个流程：主流程（任务从它的「开始」出发）和若干子流程；在流程的开始节点上可以把它设为主流程
  - 节点可以由 Agent 执行，也可以调用另一个流程（本工作流的子流程或其他工作流）
  - 每个节点有三个挂载点：**开始**（先执行这个流程，结果作为节点的初始资料）、**验收**（节点完成后执行，
    验收流程最后写「验收结论：通过 / 不通过」，不通过就把意见交回节点继续完善，最多 N 轮）、**结束**（验收通过后执行，结果并入节点输出）
  - 另有一份工作流说明（目标、规范、完成标准），每个节点执行时都会带上；画布可以全屏编辑
- **AI 创建 / 优化**：Agent 和工作流列表上的「AI 创建」，用一句话描述需求，由本机 CLI 生成完整配置；
  详情页的「AI 优化」把当前配置交给 CLI 按你的要求修改。左边对话、右边预览（工作流显示流程图），
  可以多轮修改，确认后才写入。工作流需要的新 Agent 会一并创建
- **导入 / 导出**：工作流详情页可以导出成文件（连同用到的 Agent），在另一台电脑的工作流列表里导入；同名 Agent 直接复用
- **项目**：项目是本机上的一个目录，按项目分类管理；分类指定默认工作流，项目也可以单独指定
- **任务**：首页和项目页都可以直接输入新任务，左侧栏按时间列出最近的任务。任务可以按工作流执行，也可以直接和一个 Agent 对话。
  任务页参考 Claude Code：上方按节点分段显示实时输出（文字、读文件、改文件、执行命令），开始 / 验收 / 结束流程的输出缩进显示在节点下，
  回复和思考过程流式显示，一个节点或一轮对话完成后思考和工具调用折叠成一行，只留最后的回复；
  下方继续输入要求，右侧是任务进度（含每轮验收和 CLI 的待办清单）、上下文占用、Token 用量（输入 / 输出 / 缓存命中率、实时 token/s）、改动文件和环境。
  可以切换到「流程图」视图，看每个节点的状态和验收轮次，点节点查看它的完整输出。
  失败或停止的任务可以一键「重试 / 继续执行」，从没完成的节点接着跑；任务可以重命名；
  页面不在前台时任务完成会弹出系统通知（设置里打开）。每个页面都有自己的地址，刷新、前进后退、复制链接都能回到原处
- **设置**（左下角，参考 Claude 的设置弹窗）：单步超时、系统默认 CLI、AI 创建的默认 CLI 和补充规则，
  以及每个 CLI 的三档模型（模型 + 思考强度）、默认模型（可以是某一档）、默认思考强度、权限、可执行文件路径、额外参数、环境变量；
  每个 CLI 可以一键安装、更新、卸载，模型列表从本机 CLI 读取（Codex、Command Code），跟着 CLI 的版本和账号走；
  「版本更新」对比 GitHub Releases 上的包，有新版本时可以一键更新，也可以下载或切换到最近的五个包（数据保留）
- 编辑自动保存，深色 / 浅色主题

## 快速开始

需要 Node.js 20+、git，以及至少安装一个 CLI：

| CLI | 安装 | 设置里的默认命令 |
| --- | --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude` |
| Codex CLI | `npm install -g @openai/codex` | `codex` |
| Command Code | `npm install -g command-code` | `cmdc` |

CLI 需要先在终端里登录一次（或在设置的「环境变量」里填 API Key）。

```bash
npm install
npm run dev        # 前端 http://localhost:5173 ，后端 http://127.0.0.1:8787
```

生产模式（单端口）：

```bash
npm run build
npm start          # http://127.0.0.1:8787
```

数据保存在 `data/` 下的 JSON 文件（已加入 .gitignore），可用环境变量 `AGENT_PANEL_DATA` 指定目录。
服务只监听 127.0.0.1，因为它会在本机启动 CLI、读写项目目录。

## 任务是怎么执行的

- 每次调用 CLI 都用非交互 + 结构化输出模式，任务描述通过 stdin 传入：
  - Claude Code：`claude -p --output-format stream-json --verbose --include-partial-messages …`
  - Codex：`codex app-server`（JSON-RPC，任务描述通过 `turn/start` 传入；`exec --json` 没有流式输出）
  - Command Code：`cmdc -p --output-format json --skip-onboarding --trust …`
- 工作流从主流程的「开始」出发，一个节点的上游都完成后启动它的 CLI 进程，没有依赖的节点同时运行；
  某个节点失败后不再启动新节点，正在跑的节点跑完后任务停下。
  每个节点的提示包含：原始需求、补充要求、工作流说明、本节点要做的事、开始流程的结果、上游节点的结果、同时进行的节点（避免改同一个文件）。
- 挂载的流程和流程节点在执行时展开成子节点（最多嵌套 6 层），验收不通过时把意见交给节点，续接节点自己的会话修改，再重新验收。
- 思考强度：Claude Code 用 `--effort`，Codex 用 `-c model_reasoning_effort=…`（并在 `turn/start` 里传），Command Code 用 `--effort`。
- 每个节点有自己的 CLI 会话。工作流全部完成后的追加要求交给主 Agent，续接它最后执行的节点的会话；
  失败或停止后再发消息，会从没完成的节点继续。对话任务用 `--resume` / app-server 的 `thread/resume` 续接。
- 旧版把步骤写在工作流文档 `##` 标题里的工作流，服务启动时会自动迁移成流程图。
- 改动文件：项目是 git 仓库时，对比任务开始时的 `git diff --numstat` 快照（任务前已有的改动不算）；
  不是 git 仓库时从 CLI 的改文件事件统计。
- 上下文占用和费用取自 CLI 报告的 usage。
- AI 创建：提示里写明背景、可用 CLI 和模型、图标、已有分类和 Agent、创建规则（`shared/assist.ts`）以及固定的 JSON 结构，
  要求 CLI 先说明再输出一个 ```json 代码块。服务端用 zod 校验结构，再检查重名、CLI、图标、Agent 引用是否有效；
  不合格时把错误告诉 CLI 让它修正一次。CLI 在临时目录里以只读权限运行，不碰项目文件。
- 停止任务会结束整个进程树（Windows 用 `taskkill /T /F`）。Windows 上通过 cross-spawn 调用 npm 安装的 `.cmd`。

## 测试

```bash
npm run typecheck
npm run test:e2e   # 用 scripts/fake-cli 模拟三种 CLI 的输出，走完整流程（需要 macOS / Linux 和 git）
```

端到端测试覆盖：设置与检测、按连线执行的工作流（校验没有依赖的节点确实同时运行）跨三个 CLI、调用参数、
开始 / 验收 / 结束流程（验收不通过退回、轮数用完失败）、流程节点、引用其他工作流、循环嵌套、思考强度、
续接会话、对话任务、停止、失败、系统默认 CLI 和模型档位、AI 创建（格式校验、自动修正、优化、工作流引用解析）、找不到命令、CLI 停用、读取模型列表、安装 / 卸载 CLI。

GitHub Actions：`.github/workflows/ci.yml` 在每次推送和 PR 时跑类型检查、端到端测试和构建；
`.github/workflows/pages.yml` 在推送到 main 时构建在线演示版并发布到 GitHub Pages
（首次需要在仓库 Settings → Pages 把 Source 设为 GitHub Actions）。

## 技术栈

全 TypeScript，前后端共享类型和校验：

| 部分 | 选型 |
| --- | --- |
| 前端 | React 19 + Vite + Tailwind CSS v4 + Radix UI + lucide 图标 |
| 后端 | Hono（Node）+ zod + cross-spawn |
| 存储 | 本地 JSON 文件 |

## 目录结构

```
shared/   前后端共享：数据结构（schema.ts）、CLI 注册表（clis.ts）、流程图逻辑（flow.ts）、默认设置、在线演示用的模拟执行
server/   Hono API、JSON 存储、CLI 检测、模型读取、安装 / 卸载、任务管理
  exec/   真实执行：进程管理、三种 CLI 的输出解析、git 改动统计、工作流调度
web/      React 前端
  src/components/assist/  AI 创建 / 优化对话框
  src/components/flow/    流程图布局（Pipeline）和工作流流程编辑器
  src/components/tasks/   任务列表、对话页、任务流程图、右侧面板
  src/pages/              页面（含 SettingsPage）
scripts/  端到端测试和模拟 CLI
```

## 如何扩展

- **加一种 CLI**：在 `shared/clis.ts` 加一项（命令、模型、权限、参数拼装），
  在 `server/exec/parsers.ts` 加输出解析，在 `web/src/lib/cli-style.ts` 配个颜色。
- **加一个页面**：在 `web/src/pages/` 写页面，然后在 `web/src/App.tsx` 登记。
- **改主题**：`web/src/index.css` 顶部的颜色 token。

## 路线图

1. ✅ Agent 配置（含分类）
2. ✅ 工作流：主 Agent + 子 Agent 团队，工作流文档
3. ✅ 项目：项目分类绑定默认工作流，项目绑定本地目录
4. ✅ 任务：工作流执行 / 直接对话，实时输出、追加要求、停止
5. ✅ 真实执行：Claude Code、Codex、Command Code，真实上下文用量和 git 改动
6. ✅ 流程图：自由编排的图、子流程、开始 / 验收 / 结束挂载流程，任务流程图视图
7. ✅ 用本机 CLI 对话创建、优化 Agent 和工作流
8. 审批（CLI 请求权限时在页面上确认）
