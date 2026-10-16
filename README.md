# Agent 面板

一个跑在本机的网页控制台：按项目分类，调度本机的编码 Agent（Claude Code、Codex CLI 等），
由主 Agent 按工作流文档拆解任务、分派给子 Agent 逐步执行。

当前版本：**Agent 配置 + 工作流 + 项目 + 任务（模拟执行）**。

- **Agent**：每个 Agent 是「CLI（Claude Code / Codex）+ 模型 + 角色设定」的组合，按分类管理，
  新建或编辑时可以直接新建分类；自动检测本机 CLI，预览实际执行的命令
- **工作流**：选一个主 Agent 和若干子 Agent 组成团队（子 Agent 有顺序和职责说明），
  再用 Markdown 写工作流文档，用 `@Agent名称` 指定每一步由谁执行；带模板、预览和就绪检查
- **项目**：项目是本机上的一个目录，按项目分类管理；分类指定默认工作流，项目也可以单独指定。
- **任务**：点进项目后是任务列表。任务可以按工作流执行，也可以直接和一个 Agent 对话；任务页参考 Claude Code：上方是执行输出，下方继续输入要求，右侧是任务进度、上下文估算、改动文件和环境。项目的目录、分类和工作流放在项目的「设置」里。目前执行是模拟的（`shared/runner.ts`），真实调用 CLI 是下一步。
  可以手填路径或用内置的目录浏览器选择，会检测目录是否存在、是否为 git 仓库及当前分支
- 编辑自动保存，深色 / 浅色主题

## 快速开始

需要 Node.js 20+。

```bash
npm install
npm run dev        # 前端 http://localhost:5173 ，后端 http://127.0.0.1:8787
```

生产模式（单端口）：

```bash
npm run build
npm start          # http://127.0.0.1:8787
```

配置保存在 `data/` 下的 JSON 文件（Agent、分类、工作流、项目分类、项目、任务各一个）（已加入 .gitignore），可用环境变量 `AGENT_PANEL_DATA` 指定目录。
服务只监听 127.0.0.1，因为它之后会在本机启动 CLI。

## 技术栈

全 TypeScript，前后端共享类型和校验：

| 部分 | 选型 |
| --- | --- |
| 前端 | React 19 + Vite + Tailwind CSS v4 + Radix UI + lucide 图标 |
| 后端 | Hono（Node）+ zod |
| 存储 | 本地 JSON 文件（之后可换 SQLite） |

## 目录结构

```
shared/   前后端共享：数据结构（schema.ts）、CLI 注册表（clis.ts）
server/   Hono API、JSON 存储、CLI 安装检测
web/      React 前端
  src/components/ui/      基础组件（按钮、输入框、抽屉、开关…）
  src/components/layout/  列表 + 详情布局、就绪检查
  src/components/agents/  Agent 详情、分类选择、Agent 选择器
  src/components/workflows/ 团队编辑、工作流文档编辑
  src/pages/              页面
```

## 如何扩展

- **加一种 CLI**：在 `shared/clis.ts` 的 `CLIS` 里加一项（命令、模型建议、参数模板），
  再在 `web/src/lib/cli-style.ts` 给它配个颜色。下拉框、检测、命令预览自动生效。
- **加一个页面**：在 `web/src/pages/` 写页面，然后在 `web/src/App.tsx` 的 `NAV` 里登记。
- **改主题**：`web/src/index.css` 顶部的颜色 token。

## 路线图

1. ✅ Agent 配置（含分类）
2. ✅ 工作流：主 Agent + 子 Agent 团队，工作流文档
3. ✅ 项目：项目分类绑定默认工作流，项目绑定本地目录
4. 🚧 任务：任务列表、对话页和右侧面板已完成，执行目前是模拟的
5. 真实执行：调用 claude / codex CLI，流式显示输出，读取真实的上下文用量和 git 改动
