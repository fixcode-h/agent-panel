# Agent 面板

一个跑在本机的网页控制台：按项目分类，调度本机的编码 Agent（Claude Code、Codex CLI、Command Code），
由主 Agent 按工作流文档拆解任务、分派给子 Agent 逐步执行。

- **Agent**：每个 Agent 是「CLI + 模型 + 角色设定」的组合，按分类管理；自动检测本机 CLI，预览实际执行的命令
- **工作流**：选一个主 Agent 和若干子 Agent 组成团队，用 Markdown 写工作流文档，
  每个 `##` 标题是一步，用 `@Agent名称` 指定这一步由谁执行（不写则由主 Agent 执行）
- **项目**：项目是本机上的一个目录，按项目分类管理；分类指定默认工作流，项目也可以单独指定
- **任务**：点进项目后是任务列表。任务可以按工作流执行，也可以直接和一个 Agent 对话。
  任务页参考 Claude Code：上方是实时输出（文字、读文件、改文件、执行命令），下方继续输入要求，
  右侧是任务进度、上下文占用、改动文件和环境
- **设置**（左下角齿轮）：执行方式（真实 / 模拟）、单步超时，以及每个 CLI 的
  可执行文件路径、默认模型、权限、额外参数、环境变量、安装检测
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
  - Codex：`codex exec --json --skip-git-repo-check … -`
  - Command Code：`cmdc -p --output-format json --skip-onboarding --trust …`
- 工作流按步骤依次调用对应 Agent，每一步的提示包含：原始需求、补充要求、工作流文档、本步说明、之前步骤的总结。
- 每个 Agent 在任务里有自己的会话，追加要求时用 `--resume` / `exec resume` 续接；
  工作流全部完成后的追加要求交给主 Agent。失败或停止后再发消息，会从没完成的步骤继续。
- 改动文件：项目是 git 仓库时，对比任务开始时的 `git diff --numstat` 快照（任务前已有的改动不算）；
  不是 git 仓库时从 CLI 的改文件事件统计。
- 上下文占用和费用取自 CLI 报告的 usage。
- 停止任务会结束整个进程树（Windows 用 `taskkill /T /F`）。Windows 上通过 cross-spawn 调用 npm 安装的 `.cmd`。

## 测试

```bash
npm run typecheck
npm run test:e2e   # 用 scripts/fake-cli 模拟三种 CLI 的输出，走完整流程（需要 macOS / Linux 和 git）
```

端到端测试覆盖：设置与检测、三步工作流跨三个 CLI、调用参数、续接会话、对话任务、停止、失败、
找不到命令、CLI 停用、模拟执行。

## 技术栈

全 TypeScript，前后端共享类型和校验：

| 部分 | 选型 |
| --- | --- |
| 前端 | React 19 + Vite + Tailwind CSS v4 + Radix UI + lucide 图标 |
| 后端 | Hono（Node）+ zod + cross-spawn |
| 存储 | 本地 JSON 文件 |

## 目录结构

```
shared/   前后端共享：数据结构（schema.ts）、CLI 注册表（clis.ts）、默认设置、模拟执行
server/   Hono API、JSON 存储、CLI 检测、任务管理
  exec/   真实执行：进程管理、三种 CLI 的输出解析、git 改动统计、工作流调度
web/      React 前端
  src/components/tasks/   任务列表、对话页、右侧面板
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
6. 并行步骤、审批（CLI 请求权限时在页面上确认）、任务历史搜索
