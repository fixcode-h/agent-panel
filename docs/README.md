# 项目文档

「Agent 面板」是一个跑在本机的网页控制台：按项目管理本机上的编码 CLI（Claude Code、Codex、Command Code 等），
按工作流的流程图调度主 Agent 和子 Agent 执行任务。这个目录是项目的文档根。

- 想了解功能和用法、下载和在线预览：看仓库根的 [README.md](../README.md)
- 想知道改动该放哪个目录、模块之间怎么依赖：看 [MODULE-MAP.md](MODULE-MAP.md) 和 [modules/](modules/)
- 开工前该读什么、有哪些硬规则：看根目录的 [AGENTS.md](../AGENTS.md)

## 快速开始

```bash
npm install
npm run dev        # 前端 http://localhost:5173，后端 http://127.0.0.1:8787
npm run typecheck  # 类型检查 + 漏翻检查
npm run lint       # oxlint、Prettier 格式检查、规则检查、密钥扫描
npm run test:unit  # 单元测试
npm run build      # 正式版前端（在线演示版用 npx vite build --mode demo）
```

端到端测试需要 macOS / Linux；在 Windows 上放到 WSL（Ubuntu 24.04）里跑：`npm run test:e2e:wsl`（等同于在 WSL 里 `npm run test:e2e`）。
界面检查先 `npx vite build --mode demo`，再 `node scripts/ui-check.mjs`。出包用 `npm run package`，产物在 `release/`。

## 文档索引

| 文档                                                           | 内容                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| [MODULE-MAP.md](MODULE-MAP.md)                                 | 模块表：路径、职责、入口、文档链接、状态             |
| [modules/shared/README.md](modules/shared/README.md)           | 前后端共享的数据模型、CLI 注册表、流程图和执行引擎   |
| [modules/server/README.md](modules/server/README.md)           | Hono API、JSON 存储、项目与任务管理                  |
| [modules/server-exec/README.md](modules/server-exec/README.md) | 真实调用本机 CLI：进程、输出解析、RPC 会话、worktree |
| [modules/app-actions/README.md](modules/app-actions/README.md) | 操控软件的动作表：Agent 的 `app_actions` / `app_do` 与 `/api/actions` |
| [modules/design/README.md](modules/design/README.md)           | UI 设计：设计数据、AI 对话、原画与图片生成、导出     |
| [modules/web/README.md](modules/web/README.md)                 | React 前端：页面、流程图画布、对话输出、演示模式     |
| [modules/scripts/README.md](modules/scripts/README.md)         | 端到端测试、界面检查、出包、规则检查、托盘程序       |
| [modules/skills/README.md](modules/skills/README.md)           | 随面板发布的内置 Skill                               |
| [modules/extension/README.md](modules/extension/README.md)     | 浏览器扩展：用本机已登录的 Gemini / ChatGPT 网页生图 |
| [cli-config.md](cli-config.md)                                 | 接入新 CLI 的配置文件格式和接入检查清单              |
| [model-catalog.md](model-catalog.md)                           | 模型的上下文窗口、最大输出、思考强度                 |
| [agent-catalog.md](agent-catalog.md)                           | 增删合并内置角色和工作流的判定标准                   |
| [agent-test-steps.md](agent-test-steps.md)                     | 测试步骤、角色参数、子对话隔离和合并编译             |
| [umg-export.md](umg-export.md)                                 | UI 设计的导出格式                                    |
| [lessons/README.md](lessons/README.md)                         | 项目教训：返工过的地方整理成按文件取用的规则         |
| [adr/README.md](adr/README.md)                                 | 架构决策记录（ADR）：为什么这么定、放弃了什么        |

## 文档怎么写

- **专题文档**放在本目录，读完能直接照着做（格式、命令、检查清单）；写新的之后在上面索引里登记一行。
- **模块文档**在 `modules/<模块>/README.md`，只写职责、入口、依赖和回归验证；模块边界变了先改 [MODULE-MAP.md](MODULE-MAP.md)。
- **为什么这么定**写进 [adr/](adr/README.md)；**返工教训**写进 [lessons/](lessons/README.md) 的对应分片，能变成检查的交给 `scripts/rules-check.mjs`。
- `docs/` 里引用的仓库路径必须真实存在（`npm run lint` 会检查），改名、删文件时一起改。
- 文档用 UTF-8 无 BOM、LF 换行（见仓库根的 `.editorconfig`）。
