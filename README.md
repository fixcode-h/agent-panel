# Agent 面板

一个跑在本机的网页控制台：按项目分类，调度本机的编码 Agent（Claude Code、Codex、Command Code、Gemini CLI、Pi），
由主 Agent 和子 Agent 按工作流的流程图执行：连线决定先后，没有先后关系的节点同时执行，节点里的每一步可以挂载验收流程，不通过就退回修改。
界面参考 Claude Code。

**在线预览**在仓库主页 About 里的网址（GitHub Pages：https://fixcode-h.github.io/agent-panel/ ），内容是 dev 分支的最新版；
预览版在浏览器里模拟执行，不调用 CLI。

**下载：[Releases](https://github.com/fixcode-h/agent-panel/releases)** 。包只从 main 发布；解压后只需要 Node.js 20+，Windows 双击 `AgentPanel.exe`（不弹命令行窗口，图标在任务栏通知区，启动后自动打开浏览器，右键图标退出），macOS / Linux 运行 `./start.sh`，想开机自动在后台运行就执行一次 `./install-service.sh`。Windows 第一次运行如果提示「Windows 已保护你的电脑」，是因为托盘程序没有代码签名，点「更多信息」→「仍要运行」即可。

- **Agent**：每个 Agent 是「CLI + 模型 + 角色设定」的组合，按分类管理；自动检测本机 CLI，预览实际执行的命令。
  CLI 可以选「系统默认」，模型可以只选高 / 中 / 低档，执行时按设置换成具体的 CLI、模型和思考强度，改设置就能整体切换；
  也可以单独指定思考强度
- **工作流**：选一个主 Agent 和若干子 Agent 组成团队，在流程图里自由编排：
  - 节点随意拖动摆放，从节点右侧的圆点拖线到另一个节点表示先后；新建节点不会自动连线，没连上的节点不执行。
    一个节点的上游全部完成后它才开始，没有先后关系的节点同时执行，不能连成环
  - 一个工作流可以有多个流程：主流程（任务从它的「开始」出发）和若干子流程；在流程的开始节点上可以把它设为主流程
  - 一个节点可以按顺序挂多个步骤，每一步交给一个 Agent 或调用另一个流程（本工作流的子流程或其他工作流），
    串行执行：每一步有自己的 CLI 会话，上一步的输出作为下一步的输入，某一步失败就停下
  - 节点保留**开始**和**结束**两个挂载点：开始先执行，结果作为第一步的初始资料；结束在所有步骤完成后执行，结果并入节点输出
  - **验收**和**等我确认**按步骤配置：验收流程最后写「验收结论：通过 / 不通过」，不通过就把意见交回这一步继续完善，最多 N 轮
  - 另有一份工作流说明（目标、规范、完成标准），每个节点执行时都会带上；画布可以全屏编辑，右侧属性栏可以拖动调整宽度
- **AI 创建 / 优化**：Agent 和工作流列表上的「AI 创建」，用一句话描述需求，由本机 CLI 生成完整配置；
  详情页的「AI 优化」把当前配置交给 CLI 按你的要求修改。左边对话、右边预览（工作流显示流程图），
  可以多轮修改，确认后才写入。工作流需要的新 Agent 会一并创建
- **导入 / 导出**：工作流详情页可以导出成文件（连同用到的 Agent），在另一台电脑的工作流列表里导入；同名 Agent 直接复用
- **任务导出 / 导入**：任务页「更多操作」里导出整个对话或工作流执行（带版本号的 JSON：消息、工作流定义、Agent、每个节点的结果和统计，去掉会话、本机路径和密钥）；项目首页「导入任务」导入别人导出的，只能查看
- **AI 分析与自进化**：任务页「AI 分析执行结果」或工作流详情页「分析执行」（最近 5 次），AI 判断结果质量、工作流和 Agent 哪里需要优化、面板框架有没有问题；修改建议显示成差异，勾选后才应用，框架问题列出文件位置
- **项目**：项目是本机上的一个目录，按项目分类管理；分类指定默认工作流，项目也可以单独指定。
  项目首页右上角可以展开当前项目的文件系统，直接浏览目录、搜索文件内容、打开文件
- **项目教训**：角色在项目里返工过的地方记成规则（项目设置 · 项目教训），以后这个项目里的角色都照着做。
  对话里用户消息下面点「记成项目教训」可以手动记或交给角色整理；角色被纠正后也会自己记一条（标「角色记录」）。
  每条可以写管哪些文件：新会话只带「所有改动」的全文和其余条目的标题，角色改到哪些文件再按需取全文，条目多了也不占满上下文
- **项目设置 · MCP**：识别项目目录里各个工具认的 MCP 配置（`.mcp.json`、`.cursor/mcp.json`、`.vscode/mcp.json`、`.gemini/settings.json`、`.codex/config.toml`），
  一键导入成面板管理的 MCP 工具；面板管理的工具写进 Claude Code、Codex、Gemini CLI、Pi 各自的配置文件（Command Code 的 MCP 配置暂时不管），可以按 CLI 启停、增删改、测试连接。
  配置读不懂、连不上时把原文和问题交给本机 CLI 排查，改完列表自动刷新
- **项目设置 · Skill**：列出项目里各 CLI 会读的技能目录（`.agents/skills`、`.claude/skills` 等，跟着项目一起提交），
  可以新建、改 `SKILL.md`、删除，并检查格式问题；「AI 优化」按你的要求改写说明和正文，看过结果再决定写入，「AI 修复」把内容和问题一起交给本机 CLI 处理
- **任务**：首页和项目页都可以直接输入新任务，左侧栏按时间列出最近的任务。任务可以按工作流执行，也可以直接和一个 Agent 对话。
  项目页的新建输入框里可以选这次对话用不用项目设置的 Agent（默认用）：不用时不带角色设定，直接和 CLI 对话；
  Agent 的参数在新建时在这里填，对话开始后不能再改 Agent 和参数，CLI、模型和思考强度仍可以在对话页里换。
  任务页参考 Claude Code：上方按节点分段显示实时输出（文字、读文件、改文件、执行命令），一个节点有多个步骤时按顺序列出每一步的状态，
  点步骤可以定位到它的输出；开始 / 验收 / 结束流程的输出缩进显示在节点下，
  回复和思考过程流式显示，一个节点或一轮对话完成后思考和工具调用折叠成一行，只留最后的回复；
  下方继续输入要求，右侧是任务进度（含每轮验收和 CLI 的待办清单）、上下文占用、Token 用量（输入 / 输出 / 缓存命中率、实时 token/s）、改动文件和环境，
  以及当前项目的文件系统（带 git 状态）；没有项目的聊天显示任务自己的工作目录。
  可以切换到「流程图」视图，看每个节点的状态和验收轮次，点节点查看它的完整输出。
  失败或停止的任务可以一键「重试 / 继续执行」，从没完成的步骤接着跑；任务可以重命名；
  页面不在前台时任务完成会弹出系统通知（设置里打开）。每个页面都有自己的地址，刷新、前进后退、复制链接都能回到原处
- **设置**（左下角，参考 Claude 的设置弹窗）：单步超时、系统默认 CLI、AI 创建的默认 CLI 和补充规则，
  以及每个 CLI 的三档模型（模型 + 思考强度）、默认模型（可以是某一档）、默认思考强度、上下文窗口、最大输出、权限、可执行文件路径、额外参数、环境变量；
  每个 CLI 可以一键安装、更新、卸载，模型列表从本机 CLI 读取（Claude Code 读它的 `settings.json` 和环境变量，Codex、Command Code、Pi 读 CLI 自己的列表），跟着 CLI 的版本和账号走；
  模型的上下文窗口、最大输出和思考强度按[模型目录](docs/model-catalog.md)识别，目录里没有的按 1M / 128K 估算，
  也可以让 AI 联网补全，结果写进 `~/.agent-panel/config/models.json`；
  「版本更新」对比 GitHub Releases 上的包，有新版本时可以一键更新，也可以下载或切换到最近的五个包（数据保留）
- 编辑自动保存，深色 / 浅色主题

## 快速开始

需要 Node.js 20+、git，以及至少安装一个 CLI：

| CLI          | 安装                                             | 设置里的默认命令 |
| ------------ | ------------------------------------------------ | ---------------- |
| Claude Code  | `npm install -g @anthropic-ai/claude-code`       | `claude`         |
| Codex        | `npm install -g @openai/codex`                   | `codex`          |
| Command Code | `npm install -g command-code`                    | `cmdc`           |
| Gemini CLI   | `npm install -g @google/gemini-cli`              | `gemini`         |
| Pi           | `npm install -g @earendil-works/pi-coding-agent` | `pi`             |

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

数据保存在本机的数据目录（默认 `~/.agent-panel`，里面是 JSON 文件），可用环境变量 `AGENT_PANEL_DATA` 指定别的目录。
服务只监听 127.0.0.1，因为它会在本机启动 CLI、读写项目目录。

## 任务是怎么执行的

- 每次调用 CLI 都用结构化输出；有常驻双向协议的走统一的 RPC 会话模块（`server/exec/rpc/`），任务通过协议传入：
  - Claude Code：`claude -p --output-format stream-json --verbose --include-partial-messages --input-format stream-json …`（控制消息）
  - Codex：`codex app-server`（JSON-RPC，任务描述通过 `turn/start` 传入；`exec --json` 没有流式输出）
  - Command Code：`cmdc --experimental --rpc …`（`turn/start`、`turn/steer`、`turn/interrupt`）
  - Pi：`pi --mode rpc …`（`get_state`、`prompt`、`steer`、`abort`，以 `agent_settled` 结束）
  - Gemini CLI 等没有常驻协议的：任务描述通过 stdin 传入，stdout 一行一个 JSON 事件
- 工作流从主流程的「开始」出发，一个节点的上游都完成后启动它的 CLI 进程，没有依赖的节点同时运行；
  某个节点失败后不再启动新节点，正在跑的节点跑完后任务停下。
  每个节点的提示包含：原始需求、补充要求、工作流说明、本节点要做的事、开始流程的结果、上游节点的结果、同时进行的节点（避免改同一个文件）。
- 节点里的步骤按顺序串行执行：每一步一条执行记录（`<节点>/step/<步骤 id>`）和一个独立的 CLI 会话，
  上一步的输出作为下一步的输入；任一步失败或停止，后面的步骤不再启动。验收、确认、失败重试和验收轮数都按步骤单独配置。
- 挂载的流程和流程节点在执行时展开成子节点（最多嵌套 6 层），验收不通过时把意见交给对应的步骤，续接这一步自己的会话修改，再重新验收。
- 思考强度：Claude Code 用 `--effort`，Codex 用 `-c model_reasoning_effort=…`（并在 `turn/start` 里传），Command Code 用 `--effort`。
  每个模型支持的强度不一样（CLI 报告的优先，其次模型目录里的 `efforts`），设置里只列选中的模型支持的那些；
  没有手动指定时用模型目录里的 `defaultEffort`；保存过的强度模型不认时不传给 CLI（CLI 会直接报错退出），这一轮用模型自己的默认。
- 每一步有自己的 CLI 会话（旧版单执行者节点把节点当作一步）。工作流全部完成后的追加要求交给主 Agent，续接它最后执行的节点的会话；
  失败或停止后再发消息，会从没完成的步骤继续，多步节点里已经完成的步骤不重跑；节点整体重跑时，各步骤的执行记录会删掉重建，从第一步重新开始。
  对话任务用 `--resume` / app-server 的 `thread/resume` 续接。
- 旧版把步骤写在工作流文档 `##` 标题里的工作流，服务启动时会自动迁移成流程图。
- 内置「通用项目」的主流程把「方案确认 + 实现」「文档同步 + 交付」各自合并成一个多步骤节点；
  启动时如果本机的这份还是没改过的旧版本，会自动升级并保留工作流设置和现有节点的坐标；用户改过的不覆盖。任务里存了新建时的工作流快照，旧任务不受影响。
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
npm run lint       # oxlint、Prettier 格式检查、规则检查和密钥扫描
npm run test:unit  # 执行引擎、CLI 输出解析、内置模板、前端纯逻辑等单元测试
npm run test:e2e   # 用 scripts/fake-cli 模拟各个 CLI 的输出，走完整流程（需要 macOS / Linux 和 git）
node scripts/ui-check.mjs   # 界面检查：先 vite build --mode demo（产物和源码对不上会直接失败），分片并行跑，截图在 ui-shots/
```

单元测试覆盖多步骤节点的顺序执行、步骤间交接、失败即停、每步确认 / 验收、中断续跑和子 Agent 归属，
以及内置「通用项目」旧副本的迁移。
前端也跑同一套 `tsx --test`（`web/src/**/*.test.ts`）：只测不和浏览器打交道的纯逻辑（引用卡片、推送增量合并、
就绪检查、思考强度选项），不引额外的测试框架；要真实浏览器的交给界面检查和端到端测试。

端到端测试覆盖：设置与检测、按连线执行的工作流（校验没有依赖的节点确实同时运行）跨多个 CLI、调用参数、
项目设置的 MCP 识别与导入（项目里原有的配置文件不改）和项目 Skill 读写、
开始 / 验收 / 结束流程（验收不通过退回、轮数用完失败）、流程节点、引用其他工作流、循环嵌套、思考强度、
续接会话、对话任务、停止、失败、系统默认 CLI 和模型档位、AI 创建（格式校验、自动修正、优化、工作流引用解析）、找不到命令、CLI 停用、读取模型列表、安装 / 卸载 CLI。

GitHub Actions：`.github/workflows/ci.yml` 在推送到 dev 和 PR 时跑类型检查、代码检查和格式、单元测试、端到端测试、构建，并做界面检查；
`.github/workflows/release.yml` 只在推送到 main 时运行，先跑同样的检查再出包发布；
`.github/workflows/pages.yml` 在 dev 检查通过后构建在线演示版并发布到 GitHub Pages
（首次需要在仓库 Settings → Pages 把 Source 设为 GitHub Actions）。

## 技术栈

全 TypeScript，前后端共享类型和校验：

| 部分 | 选型                                                       |
| ---- | ---------------------------------------------------------- |
| 前端 | React 19 + Vite + Tailwind CSS v4 + Radix UI + lucide 图标 |
| 后端 | Hono（Node）+ zod + cross-spawn                            |
| 存储 | 本地 JSON 文件                                             |

## 目录结构

```
shared/   前后端共享：数据结构（schema.ts）、CLI 注册表（clis.ts 和 clis/ 下的配置）、流程图逻辑（flow.ts）、
          工作流执行引擎（engine.ts）、内置角色和工作流模板（builtin/）、英文文案（locales/en/）、默认设置、在线演示用的模拟执行
server/   Hono API、JSON 存储、CLI 检测、模型读取、安装 / 卸载、任务管理、MCP 配置读写
  exec/   真实执行：进程管理、各 CLI 的输出解析（常驻协议适配在 rpc/）、git 改动统计、工作流调度
web/      React 前端
  src/components/  assist/（AI 创建 / 优化）、ai-fix/（AI 处理对话框）、flow/（流程图布局和流程编辑）、
                   files/（文件树和文件面板）、tasks/（任务列表、对话页、任务流程图、右栏）、projects/、settings/
  src/pages/       Agents、Workflows、Home、Projects、Chat、Library（Skills 与命令）、Mcp、Design、Comfy、Settings
scripts/  端到端测试（e2e/、e2e.mjs）、模拟 CLI（fake-cli/）、界面检查（ui-check.mjs）、出包、
          规则检查 / 漏翻检查 / 密钥扫描、教训检索、托盘和开机自启脚本
skills/   自带的 Skill（见 skills/README.md）
extension/ 浏览器扩展：让面板用已登录的 Gemini / ChatGPT 网页生图
docs/     专题文档（见下面「文档」）；docs/lessons/ 是开发时踩过的坑，按改动的文件取用
```

## 文档

- [docs/cli-config.md](docs/cli-config.md)：接新 CLI、参数 / 输出解析 / 思考强度 / API 模式（开头有接入检查清单）
- [docs/model-catalog.md](docs/model-catalog.md)：模型的上下文窗口、最大输出和思考强度怎么定
- [docs/agent-catalog.md](docs/agent-catalog.md)：增删合并内置角色或工作流的判定标准
- [docs/agent-test-steps.md](docs/agent-test-steps.md)：测试步骤、角色参数、子对话隔离和合并编译
- [skills/README.md](skills/README.md)：自带 Skill 的分类、写法和运行依赖
- [docs/umg-export.md](docs/umg-export.md)：UI 设计的导出格式（给 UE 生成 Widget Blueprint 的数据）
- [docs/adr/README.md](docs/adr/README.md)：架构决策记录（ADR），什么时候写、各节怎么写
- [docs/lessons/README.md](docs/lessons/README.md)：踩过的坑怎么记、怎么取用
- [AGENTS.md](AGENTS.md)：在这个仓库里工作的约定（分支、命令、提交说明、硬规则），给人和 AI 看

## 如何扩展

- **加一种 CLI**：写一份 JSON 配置，不用改代码，格式和接入检查清单见 [docs/cli-config.md](docs/cli-config.md)。
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
8. ✅ 审批（CLI 请求权限时在页面上确认）
9. ✅ 项目教训：返工过的地方记成规则，新会话按改到的文件取用
10. ✅ 子对话：派子任务、合并编译，几个对话各自在独立分支里改
11. ✅ UI 设计生成与导出（HTML / React / JSON、UMG），ComfyUI、图库、MCP、浏览器扩展
12. ✅ 外网访问、版本更新、托盘 / 开机自启、在线演示版

## 安全

发现安全问题**不要**开公开 Issue：请按 [SECURITY.md](SECURITY.md) 里的方式私下报告。本项目在本机运行、会接触编码 CLI 和 API key，涉及密钥泄露的报告优先处理。

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 授权。第三方依赖的许可证与版权声明见 [NOTICE](NOTICE)，以及各依赖包目录下随附的 LICENSE 文件。
