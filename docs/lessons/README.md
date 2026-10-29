# 项目教训（docs/lessons/）

AI 助手在这个仓库里返工过的地方，整理成**下次改到同一块代码时自动看到**的规则。
目标是少返工，同时不让每次对话都读一大堆文档：按改动的文件只取相关的几条，能变成检查的就交给检查，文档里只留指针。

## 怎么用

```bash
node scripts/lessons.mjs                    # 按当前改动（git 未提交的文件）输出相关的教训
node scripts/lessons.mjs shared/clis/pi.json server/models.ts   # 按要改的文件输出
node scripts/lessons.mjs --list             # 只列每条的标题，几百个字
```

- **动手前**：想好要改哪些文件，先跑第二条；拿不准就 `--list` 扫一眼标题，点名读相关的那个分片。
- **提交前**：再跑一次第一条，对照自己的改动看有没有踩中。
- 不用整目录通读。分片按 `paths` 命中，没命中的分片和你这次的改动无关。

## 什么时候写

出现下面任一情况，在**同一个提交**里补一条（或改已有的一条）：

1. 用户纠正了 AI 的做法（「应该写进配置文件」「不要这样」）。
2. 修的是之前 AI 改出来的问题，或者补之前漏掉的配套改动。
3. 同一类修复第二次出现。

一次性的笔误、和代码无关的偏好不写；用户的长期偏好写进对应分片（例如界面偏好在 `ui.md`）。

## 一条怎么写

```markdown
## 标题：一句话说清该怎么做（不是发生了什么）

- 规则：做什么、不做什么，具体到文件或字段。
- 起因：哪次返工（提交号 + 一句话）。只留最能说明问题的一两次。
- 防线：哪个检查或测试会拦住；还没有就写「人工」。
```

- 写成**通用规则**，具体事件只作起因。例：不写「Command Code 的强度要写进 commandcode.json」，
  写「CLI 才有的行为做成 CliSpec 字段，所有 CLI 按字段走」——下一个新 CLI 才用得上。
- 每条不超过 6 行；每个分片不超过 6 KB（`scripts/rules-check.mjs` 会检查）。
- 分片开头的 `paths` 写它管哪些文件（逗号分隔的 glob，`**` 跨目录）。新增分片时选「改这些文件的人一定要知道」的范围，别写 `**`。
- 新的一条先找 `paths` 最窄、又能覆盖它的那个分片放；没有合适的就按功能模块新开一个，不往宽范围的分片里堆。

## 怎么让它不越积越多

教训分四级，越往下越省 token，能往下走就往下走：

| 级别     | 放在哪                                      | 成本                |
| -------- | ------------------------------------------- | ------------------- |
| 自动检查 | 测试、`scripts/rules-check.mjs`、typecheck  | 0，违反了 CI 直接挂 |
| 清单     | 对应专题文档里的检查清单（如 CLI 接入清单） | 做这类事时才读      |
| 分片     | `docs/lessons/<领域>.md`                    | 改到相关文件时才读  |
| 常驻     | `AGENTS.md`                                 | 每次对话都读，最贵  |

- **能写成检查就写成检查**，然后把分片里那条缩成一行指针（「防线」写检查名），或者直接删掉。
- 只有所有改动都适用、又没法检查的才进 `AGENTS.md`。
- **分片按功能模块拆**：一条规则只和某个模块有关（输入框、附件、后台命令、提问窗口……），就放进 `paths` 只覆盖那个模块的分片；`paths` 是整片目录（`web/src/**`、`server/exec/**`）的宽分片只放这片代码都适用的通用规则。
- 分片过了 4 KB 就开始拆，别等到 6 KB 的上限：把只和某个模块有关的几条挪进新分片，新分片的 `paths` 要比原来的窄。只换文件名、`paths` 照抄不算拆——改同一个文件照样两份都读，一个字没省（`scripts/rules-check.mjs` 会拦两个分片的 `paths` 完全一样）。
- 拆不动（剩下的几条都指向同一个文件）时再合并同类项：几条讲的是同一个原则就合成一条，起因各留一个提交号。
- 规则对应的代码删了或重写了，这条一起删。

## 分片

按名字排。拆分片、加分片时同步这张表。

| 分片                                             | 管什么                           |
| ------------------------------------------------ | -------------------------------- |
| [alerts.md](./alerts.md)                         | 执行出错和没有响应               |
| [asks.md](./asks.md)                             | 提问窗口                         |
| [attachments.md](./attachments.md)               | 附件                             |
| [background.md](./background.md)                 | 后台命令                         |
| [builtin.md](./builtin.md)                       | 内置角色、工作流和 Skill         |
| [child-idle-ask.md](./child-idle-ask.md)         | 子对话没有输出时自动询问         |
| [child-wrapup.md](./child-wrapup.md)             | 子对话收尾和独立分支             |
| [cli-process.md](./cli-process.md)               | 启动 CLI 进程和解析输出          |
| [cli.md](./cli.md)                               | CLI 定义、模型和思考强度         |
| [composer.md](./composer.md)                     | 对话输入框                       |
| [data.md](./data.md)                             | 数据结构、存储、升级兼容和出包   |
| [design.md](./design.md)                         | UI 设计 Agent 的验收             |
| [e2e.md](./e2e.md)                               | 端到端测试和假 CLI               |
| [execution.md](./execution.md)                   | 一轮执行怎么收尾                 |
| [list-pane.md](./list-pane.md)                   | 中间列表栏                       |
| [local-image.md](./local-image.md)               | 本机生图（ComfyUI 安装、启动）   |
| [memory.md](./memory.md)                         | 对话数据的内存和落盘             |
| [messages.md](./messages.md)                     | 对话里的消息和条目               |
| [plan.md](./plan.md)                             | 执行计划                         |
| [process.md](./process.md)                       | CLI 进程：停止、保活和回收       |
| [project-files.md](./project-files.md)           | 面板往用户项目里临时写的文件     |
| [prompts.md](./prompts.md)                       | 给 Agent 的提示词                |
| [retry.md](./retry.md)                           | 报错后的重试                     |
| [review.md](./review.md)                         | 收尾评审                         |
| [rpc-steer.md](./rpc-steer.md)                   | 常驻协议的插话                   |
| [server.md](./server.md)                         | 服务端接口和访问控制             |
| [settings.md](./settings.md)                     | 项目设置                         |
| [state.md](./state.md)                           | 对话状态和父子对话之间的交付     |
| [status-bar.md](./status-bar.md)                 | 输入框上方的状态栏               |
| [steering.md](./steering.md)                     | 插话和运行中发来的消息           |
| [task-export.md](./task-export.md)               | 导出报告的口径                   |
| [testing.md](./testing.md)                       | 测试：增删、降级和断言           |
| [tooling.md](./tooling.md)                       | 面板工具通道（MCP）和 AI 的用法  |
| [triage.md](./triage.md)                         | 父对话分诊和就地微改动           |
| [ui-check-transient.md](./ui-check-transient.md) | 界面检查：会自己消失的元素       |
| [ui-check.md](./ui-check.md)                     | 界面检查（scripts/ui-check.mjs） |
| [ui.md](./ui.md)                                 | 界面通用：文案、命名和状态判定   |
| [usage.md](./usage.md)                           | 用量和速度的统计口径             |
| [visual.md](./visual.md)                         | 视觉：部件、底色和字重           |
| [worktree.md](./worktree.md)                     | 独立工作目录（worktree）         |
