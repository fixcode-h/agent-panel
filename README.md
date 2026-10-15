# Agent 面板

一个跑在本机的网页控制台：按项目分类，调度本机的编码 Agent（Claude Code、Codex CLI 等），
由主 Agent 按工作流文档拆解任务、分派给子 Agent 逐步执行。

当前版本：**Agent 配置**。

- 新建 / 编辑 / 复制 / 删除 Agent
- 每个 Agent 选择 CLI（Claude Code / Codex）和模型，可写角色设定和额外参数
- 恰好一个主 Agent，其余为子 Agent，可一键切换
- 自动检测本机是否装了对应 CLI，并预览实际会执行的命令
- 深色 / 浅色主题

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

配置保存在 `data/agents.json`（已加入 .gitignore），可用环境变量 `AGENT_PANEL_DATA` 指定目录。
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
  src/components/agents/  Agent 卡片、编辑器
  src/pages/              页面
```

## 如何扩展

- **加一种 CLI**：在 `shared/clis.ts` 的 `CLIS` 里加一项（命令、模型建议、参数模板），
  再在 `web/src/lib/cli-style.ts` 给它配个颜色。下拉框、检测、命令预览自动生效。
- **加一个页面**：在 `web/src/pages/` 写页面，然后在 `web/src/App.tsx` 的 `NAV` 里登记。
- **改主题**：`web/src/index.css` 顶部的颜色 token。

## 路线图

1. ✅ Agent 配置
2. 工作流：选择主 Agent + 子 Agent，编写工作流文档
3. 项目分类：每个分类绑定一个工作流和本地目录
4. 执行：按用户描述启动主 Agent，实时查看各 Agent 输出
