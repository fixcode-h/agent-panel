# Agent 面板

一个跑在本机的网页控制台：按项目分类，调度本机的编码 Agent（Claude Code、Codex CLI 等），
由主 Agent 按工作流文档拆解任务、分派给子 Agent 逐步执行。

当前版本：**Agent 配置 + 工作流**。

- **Agent**：每个 Agent 是「CLI（Claude Code / Codex）+ 模型 + 角色设定」的组合，按分类管理，
  新建或编辑时可以直接新建分类；自动检测本机 CLI，预览实际执行的命令
- **工作流**：选一个主 Agent 和若干子 Agent 组成团队（子 Agent 有顺序和职责说明），
  再用 Markdown 写工作流文档，用 `@Agent名称` 指定每一步由谁执行；带模板、预览和就绪检查
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

配置保存在 `data/` 下的 `agents.json`、`categories.json`、`workflows.json`（已加入 .gitignore），可用环境变量 `AGENT_PANEL_DATA` 指定目录。
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
3. 项目分类：每个分类绑定一个工作流和本地目录
4. 执行：按用户描述启动主 Agent，实时查看各 Agent 输出
