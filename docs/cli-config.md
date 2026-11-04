# 接入新的 CLI：配置文件格式

面板按一份 JSON 配置调用 CLI：命令和参数怎么拼、输出怎么解析、支持哪些能力、Skill 和项目说明文件在哪。
接入一个新的 CLI 只要写一份配置，不用改代码。

- **自己用**：把配置放进数据目录的 `config/clis/`（默认 `~/.agent-panel/config/clis/`，文件名随意，以 `.json` 结尾），
  到「设置 · CLI」底部点「重新读取」。写错的地方会显示在那里。
- **内置到面板**：放在仓库的 `shared/clis/` 下，在 `shared/clis.ts` 的 `BUILTIN_SPECS` 里引入，
  界面文案的英文写进配置的 `i18n.en`（或 `shared/locales/en/`），再给 `scripts/fake-cli` 和 `server/exec/fixtures/` 补上样本和测试。

前提：CLI 要有**结构化输出**。一次性执行的 CLI 用非交互模式（任务描述从 stdin 读，跑完就退出）；有常驻双向协议的 CLI 把 `protocol` 写成 `rpc`，
按下面的 `rpc` 配置握手、开始一轮、插话和判断结束。四个内置 CLI 都是这样一份配置：
[`claude.json`](../shared/clis/claude.json)、[`codex.json`](../shared/clis/codex.json)、
[`commandcode.json`](../shared/clis/commandcode.json)、[`pi.json`](../shared/clis/pi.json)。
Claude Code、Codex 的协议差别较大，配置里写 `rpc.kind` 为 `claude` / `codex`，由内置适配器处理审批和控制消息（同样经过统一的 RPC 会话引擎）；
其余标准的 JSON-RPC 或按 `type` 区分的记录流只写配置就能接。

Claude Code 的审批和提问都靠控制消息：启动参数 `--permission-prompt-tool stdio` 让 CLI 把 `control_request(can_use_tool)` 交给面板，
转成卡片后 `AskUserQuestion` 的回答写回 `updatedInput.answers`。**跳过确认（`--dangerously-skip-permissions`）时也要带这个参数**：
不带它 Claude Code 不把 `AskUserQuestion` 放进工具列表，模型的提问只能变成纯文本，卡片弹不出来（参数见 [`shared/clis/claude.json`](../shared/clis/claude.json) 的 `args`，转换见 `server/exec/rpc/claude.ts`）。

## 接入检查清单

接新 CLI（或给已有 CLI 加一种能力）时逐项过一遍，漏掉的项以前都返工过（见 [lessons/cli.md](./lessons/cli.md)）：

1. **思考强度**：CLI 支持哪几档写进 `efforts`；强度由模型决定的写 `effortsFromModel`；会话中途不能换的写 `effortBoundSession`；
   能真正关掉思考的那一档标 `"off": true`（Pi 的 `off`、Codex 的 `none`、Claude Code 的 `off`），没有参数、要靠环境变量的写在这一档的 `env`；只是「不带思考参数」、接口照样会思考的不算，不要列；
   `tiers` 三档各配好默认的模型和强度。不要在代码里按 CLI 名字补档位。
2. **模型**：模型从哪读（`modelsFrom` 或内置列表），上下文和最大输出能不能从 CLI 拿到，拿不到的补进[模型目录](./model-catalog.md)。
3. **写回 CLI 自己的配置**（`auth.api.edits`）：CLI 靠模型条目判断能力时，配上 `modelEfforts` / `modelReasoning` / `modelDefaultEffort` / `modelLimits` / `modelInput`，
   写完用 CLI 自己的列表或界面核对能选几档。
4. **参数和协议**：`args` 覆盖 model、effort、permission、resume、fork；常驻协议的握手、插话、中断、结束判断都有。角色说明能传文件的写 `systemPromptFileFlag`（Windows 上参数里不能带换行，见 `server/exec/process.ts`）；没有系统提示词参数、只能靠插件追加的写 `systemPromptMod`（Command Code 的 `--mod`，见下面「回复语言」）。
5. **能力** `features`：压缩、自动压缩、分叉、插话（`steer` 或 `notes`）、「/命令」，按 CLI 实际支持的写，不支持的面板会走兜底做法。
   **钩子** `hooks`（ADR 0049）：CLI 有「模型准备结束时问一下、能让它接着做」的钩子就声明 `beforeEnd`：`via: command` 是一条命令（Claude Code 的 Stop，写 `files` / `block`），`via: extension` 写在面板每轮装进去的扩展里（Pi 的 `agent_before_settle`、Command Code mod 的 `onStop`）。工具前、工具后、压缩后写在 `events` 里（各自的 `files`、`deny`、`context` 模板），命令类钩子共用 `args`；`toolNames` 把工具名对照到 shell / edit / read，`toolFields` 写工具名、参数、文件路径在原生输入的哪个字段；回复文字的字段一律列进 `dropInput`。没有的 CLI 只靠一轮结束后的提醒兜底，设置页「钩子」上照实写不支持。
6. **测试**：`scripts/fake-cli` 能模拟它（含 RPC 多轮），`server/exec/fixtures/` 录一段真实输出并加解析测试。
7. **文案**：界面上的名字、说明的英文写进 `i18n.en`。新加的字段登记进本文档的表格，并回头看已有的 CLI 要不要填。

## 字段

| 字段                              | 说明                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                              | 唯一标识，小写字母、数字和 `-`，写进设置和 Agent 配置里，定了就别改                                                                                                                                                                                                                                                                                    |
| `name`                            | 界面上显示的名字                                                                                                                                                                                                                                                                                                                                       |
| `command`                         | 可执行文件名（设置里可以改成完整路径）                                                                                                                                                                                                                                                                                                                 |
| `versionArgs`                     | 检测是否安装、显示版本用的参数，默认 `["--version"]`                                                                                                                                                                                                                                                                                                   |
| `npmPackage` / `brew` / `docsUrl` | 设置里的安装、卸载、更新和文档链接                                                                                                                                                                                                                                                                                                                     |
| `npmRenameFrom`                   | 改名前用过的 npm 包名：安装新包前先卸掉旧的，否则两个包提供同一个命令时 npm 会报 `EEXIST`                                                                                                                                                                                                                                                              |
| `color`                           | 界面上的标识色                                                                                                                                                                                                                                                                                                                                         |
| `images`                          | CLI 内置了生成图片的工具（UI 设计里用，例如 Codex）                                                                                                                                                                                                                                                                                                    |
| `todos`                           | CLI 自带的待办 / 计划会被面板解析成 `task.todos`（Claude Code 的 `TodoWrite`、Codex 的计划）：Chat 模式的提示词据此才说「面板会显示你的待办」，没写的 CLI 让模型在回复里列计划                                                                                                                                                                         |
| `modelsRead`                      | 模型列表是运行 CLI 读出来的（例如 Codex 的 app-server）：界面上这组叫「{cli} 读取」，否则叫「{cli} 内置」                                                                                                                                                                                                                                              |
| `extraArgsKeep`                   | 设置里的「额外参数」只保留这些参数（每个带一个值，长参数也认 `--x=值`），其余丢掉；例如 Codex 的 app-server 只认 `-c`、`--enable`、`--disable`。不写时全部保留                                                                                                                                                                                         |
| `models`                          | 模型建议 `[{ "id", "label", "isDefault" }]`，用户也可以手填；上下文窗口、最大输出和思考强度按[模型目录](./model-catalog.md)识别                                                                                                                                                                                                                        |
| `efforts`                         | 思考强度 `[{ "id", "label", "off", "env" }]`，不支持就不写；`off: true` 标出「关掉思考」那一档，`env` 是选了这一档时加的环境变量（值是 JSON 对象时和已有的同名变量合并），见下文「关掉思考」                                                                                                                                                           |
| `effortsFromModel`                | 思考强度跟着模型走：模型目录/配置里这个模型支持哪些就能选哪些；为 `true` 时不用 `efforts` 过滤                                                                                                                                                                                                                                                         |
| `effortBoundSession`              | 会话不支持中途换思考强度：换了强度也开新会话，把之前的对话带过去                                                                                                                                                                                                                                                                                       |
| `tiers`                           | 高、中、低三档默认的 `{ "model", "effort" }`                                                                                                                                                                                                                                                                                                           |
| `permissions`                     | 权限选项 `[{ "id", "label", "hint" }]`，`id` 会作为 `{permission}` 填进参数                                                                                                                                                                                                                                                                            |
| `defaultPermission`               | 默认权限，不写时用第一个                                                                                                                                                                                                                                                                                                                               |
| `readOnlyPermission`              | 只分析、不改文件时用的权限（例如优化项目说明）                                                                                                                                                                                                                                                                                                         |
| `args`                            | 参数规则，见下面                                                                                                                                                                                                                                                                                                                                       |
| `output`                          | 输出解析，见下面                                                                                                                                                                                                                                                                                                                                       |
| `systemPromptFlag`                | 追加系统提示词的参数（如 `--append-system-prompt`）；写 `true` 表示 CLI 的协议里就能传、不加参数（Codex 的 `developerInstructions`）；不写时角色说明拼进任务描述                                                                                                                                                                                       |
| `systemPromptFileFlag`            | 系统提示词能传文件时用的参数（值写成文件路径，例如 Pi 的 `--append-system-prompt`）：填了就把角色说明写进临时目录传路径，参数里不带换行                                                                                                                                                                                                                |
| `systemPromptMod`                 | 系统提示词只能靠 mod / 插件追加（Command Code 的 `--mod`）：面板生成一个只追加「回复语言」规则的 mod，参数里传路径（`{systemPromptModPath}`）                                                                                                                                                                                                          |
| `features`                        | 能力，见下面                                                                                                                                                                                                                                                                                                                                           |
| `docs`                            | 项目里每次启动会读的说明文件（相对项目目录），第一个是还没有文件时新建的                                                                                                                                                                                                                                                                               |
| `docsNote`                        | 项目设置里说明文件那一页的说明                                                                                                                                                                                                                                                                                                                         |
| `globalDoc`                       | 用户目录里的全局说明文件（所有项目都读），设置的「部署」页往这里写；为空表示不支持                                                                                                                                                                                                                                                                     |
| `context`                         | 会话栏「上下文」细分里 CLI 自己那部分的估计值：`systemPrompt`、`systemTools`（token）、`compactReserve` / `compactReservePct`（自动压缩余量）、`docsMode`（`all` / `first`）、`docsImports`（展开 `@路径`）；见 `shared/context-breakdown.ts`。CLI 自己能报细分时（Claude Code 的 `get_context_usage`）按报的来，这些估计值只在报不出来时用            |
| `skills`                          | Skill 目录 `{ "user": ["~/.x/skills"], "repo": [".x/skills"] }`，每个子目录一个 `SKILL.md`                                                                                                                                                                                                                                                             |
| `commands`                        | 自定义命令目录 `{ "user", "repo", "format": "md" \| "toml", "prefix" }`，输入框打「/」时列出来                                                                                                                                                                                                                                                         |
| `envExample`                      | 设置里环境变量的示例                                                                                                                                                                                                                                                                                                                                   |
| `env`                             | 每次运行都加的环境变量 `{ "KEY": "VALUE" }`，设置页的「默认环境变量」会逐项列出、可以改值和恢复默认；用户在设置里写的同名变量优先（例如让无界面运行信任工作目录）                                                                                                                                                                                      |
| `stderrNoise`                     | stderr 里和失败无关的常驻提示行 `[{ "pattern", "why" }]`（`pattern` 按行匹配的正则）：进程中途退出时，失败原因里的「stderr 最后几行」去掉这些行，先写退出码 / 信号（Claude Code 接第三方模型时的 `[claude-code:unrecognized_model]`）                                                                                                                  |
| `compactThrash`                   | CLI 自动压缩「抖动」时的报错 `{ "pattern", "why" }`（`pattern` 不分大小写的正则）：认出来时面板不直接判失败，先在对话里写一行警告、在原会话里续一轮让模型分段读取，再失败才报失败（Claude Code 的 `Autocompact is thrashing`）。不写表示没有这种报错                                                                                                   |
| `mcp`                             | 怎么把面板的工具（MCP）交给 CLI，见下面；不写时用不了 UI 设计的 AI                                                                                                                                                                                                                                                                                     |
| `hooks`                           | 钩子：`args`、`beforeEnd`（`via`、`files`、`block`）、`events`（`tool.before` / `tool.after` / `context.restored` 的 `files`、`deny`、`context`）、`dropInput`、`toolNames`、`toolFields`，见 `shared/hooks.ts`、ADR 0049；不写时只靠一轮结束后的提醒                                                                                                  |
| `options`                         | 设置里给用户的开关 `[{ "id", "label", "hint", "default", "env", "choices" }]`：打开时加上 `env`，参数规则里用条件 `opt.<id>` 判断（Pi 的「离线运行」「codemode」，Claude Code 的「不用 Claude Code 自带的记忆」）；写了 `choices: [{ "id", "label" }]` 的是下拉选项，`default` 写其中一个 id，参数里用 `{opt.<id>}` 填选中的值（Codex 的「思考摘要」） |
| `packages`                        | CLI 自己的插件（扩展包），设置里能装、删、更新，推荐的一键安装，见下面「插件」                                                                                                                                                                                                                                                                         |
| `i18n`                            | 界面文案的翻译 `{ "en": { "中文": "English" } }`                                                                                                                                                                                                                                                                                                       |

目录里的 `~` 是用户目录，`${ENV:-默认值}` 先取环境变量。

## 设置页里能改什么

内置和用户自己的 CLI 都在「设置 → Agent → <CLI>」里配置。定义里有一部分字段会直接生成界面，不用改 JSON：

| 设置页里的项 | 来自定义                               | 存在哪                                           |
| ------------ | -------------------------------------- | ------------------------------------------------ |
| 权限         | `permissions` / `defaultPermission`    | `CliSettings.permission`                         |
| 最大回合     | 面板统一项                             | `CliSettings.maxTurns`                           |
| 开关         | `options`（打开时注入它带的 `env`）    | `CliSettings.options`                            |
| 自动压缩     | `autoCompact` / `compact` 决定说明文字 | `CliSettings.autoCompact`                        |
| 默认环境变量 | `env` 的每个键和默认值                 | `CliSettings.env` 里同名的键；值改回默认值时不留 |
| 额外参数     | `extraArgsKeep` 决定哪些参数保留       | `CliSettings.extraArgs`                          |
| 环境变量     | `envExample` 只作输入框示例            | `CliSettings.env` 里用户自己加的键               |
| 可执行文件   | `command`                              | `CliSettings.command`                            |

「默认环境变量」和「环境变量」共用一个保存字段：定义里已有的键只在「默认环境变量」里编辑，写进 `CliSettings.env` 的同名键覆盖定义值；点「恢复默认」删掉这条覆盖，回到定义里的值。启动 CLI 时 `cliSettings()` 按「定义 env → 开关 env → 用户 env → API 注入」合并，后面的同名键生效，所以界面显示的值就是实际传给 CLI 的值。`options` 开关带的 env 不放进自由编辑，由开关控制。

只能改 JSON 的字段：`args` / `rpcArgs` 参数模板、`features`、`output` 输出解析、`rpc` 协议、`mcp`、`packages`、`models` 建议、`efforts`、`tiers` 默认值、`stderrNoise`、`compactThrash`、`i18n` 等。用户自己的配置放在 `config/clis/`，改完到「设置 → Agent」底部点「重新读取」；内置的改完要重新构建或升级面板。

## 参数规则 `args`

按顺序检查每一条，条件都满足时加上 `args`；设置里的「额外参数」放在最后。任务描述走 stdin，不在参数里。

```json
"args": [
  { "args": ["--output-format", "stream-json"] },
  { "if": "model", "args": ["-m", "{model}"] },
  { "if": "permission=yolo", "args": ["--yolo"] },
  { "if": ["permission", "permission!=yolo"], "args": ["--approval-mode", "{permission}"] },
  { "if": "resume", "args": ["--resume", "{resume}"] },
  { "if": ["resume", "fork"], "args": ["--fork-session"] },
  { "if": "addDirs", "args": ["--include-directories", "{addDirs|,}"] },
  { "each": "addDirs", "args": ["--add-dir", "{item}"] },
  { "args": ["--max-turns", "{maxTurns:200}"] }
]
```

- 条件：`model` 有值、`!resume` 没值、`permission=yolo` 等于、`permission!=yolo` 不等于、`opt.codemode` 设置里这个开关开着（下拉选项选了任意一项都算）；写成数组时全部满足才加。下拉选项选中的值用 `{opt.<id>}` 取。
  同一个参数只认最后一次的 CLI（例如 Pi 的 `--tools`），开关要和权限组合成几条规则，并进同一个值里。
- 能用的值：`model`、`effort`、`permission`、`resume`（续接的会话 id）、`fork`（要分叉会话）、`forkBefore`（`features.fork` 为 `before` 时要丢掉的第一轮的 id）、`forkEnd`（`features.fork` 为 `end` 时截到的那条回复，Claude Code 的 `--resume-session-at`）、`systemPrompt`、`systemPromptFile`（`systemPrompt` 已经写成文件、值是路径）、`systemPromptModPath`（面板生成的语言 mod 路径）、`maxTurns`、`addDirs`（工作目录外还要读的目录，例如附件）、`noEdit`（这一轮不许改文件）、`textOnly`（只要一段文字的一次性小活，例如起对话标题：能关掉全部工具、换极简系统提示的 CLI 写一条规则，Claude Code 是 `--tools "" --system-prompt …`；没写规则的照常跑）、`autoCompactTokens`（`features.autoCompact` 为 `config` 时的 token 数）、`contextWindow` / `maxOutput`（设置里手动改的上限，见 `features.limitArgs`）。
- 规则里自己写了 `{systemPrompt}` 时（例如按 `systemPromptFile` 选参数），面板不再在末尾自动补系统提示词那一条。
- 每条规则可以带一个 `why` 写为什么这样传（JSON 里没法写注释），面板不读。
- 占位：`{model}`；`{addDirs|,}` 把数组用逗号连起来；`{maxTurns:200}` 没值时用 200；`each` 对数组每一项加一次，`{item}` 是那一项。

## 回复语言

面板设置里的界面语言决定 Agent 的回复正文和思考过程（reasoning / thinking）用哪种语言，规则在 `shared/prompt-lang.ts`，每轮执行时现算。对话页保活中的进程把系统提示词和 mod 的环境变量固定在了进程里，所以设置换了以后下一句不会再交给它：`server/exec/runner.ts` 的 `stillCurrent` 会比对语言，不一致就结束等待、按新语言重开进程。正在跑的那一轮（含等子任务期间送进去的消息）仍用开始时的语言，下一轮才换。注入方式按 CLI 的能力从强到弱：

1. 有 `systemPromptFlag` 的（Claude Code、Codex、Pi）：规则和角色说明一起进系统提示词。
2. 有 `systemPromptMod` 的（Command Code）：面板在数据目录生成 `mods/agent-panel-prompt-lang.mjs`，用 `--mod` 加载，`appendSystemPrompt` 把规则追加到系统提示词末尾；语言由环境变量 `AGENT_PANEL_REPLY_LANG` 传，不重写文件。本机验证 Command Code 1.88 可用；更旧的版本不认识这个参数时先升级。
3. 其余 CLI（没有系统提示词参数，也没有 mod 通道）：规则写在任务描述里，并在末尾再提醒一次。

**能力边界**：

- 模型的原生 reasoning 由它自己的系统提示词和训练决定，提示词只能影响、不能强制。实测 Command Code + DeepSeek 会把任务描述里的中文规则忽略掉（思考输出英文），追加到系统提示词后才稳定；只有任务描述通道的 CLI 仍可能不遵守。
- 设置是 `auto` 时，界面语言按浏览器的 `navigator.language` 解析，服务端（`server/lang.ts`）按 `process.env.LANG` / 系统 locale 解析；**回复语言不跟界面语言走**，规则改成「用用户这条消息（或交给它的任务说明）的语言」（`ReplyLang` 的 `auto-zh` / `auto-en`，后缀只是看不出语言时的兜底和规则本身的语言）。以前按解析出的语言写死，系统语言是 `C.UTF-8` 时中文提问收到英文回复。设置成中文 / 英文时仍固定用那种语言。
- `auto` 时总结卡的类型和字段名仍按服务端解析出的界面语言列表（`shared/summary-card.ts`），回复语言和它不同时可能混写；界面两种字段名都认得。
- 不要为了让思考语言变过来去改用户的全局配置。

## 常驻 RPC `protocol` / `rpc`

一次性执行的 CLI 不写 `protocol`（默认 `stdin`）。有常驻双向协议的写 `"protocol": "rpc"`，参数用 `rpcArgs`（不带 `-p`、`--output-format` 这类一次性参数），
协议本身写在 `rpc` 里。所有 RPC 走同一个会话引擎：stdin/stdout 上的 JSON 行、请求 id 配对、超时、插话、中断和收尾都一样。

```json
"protocol": "rpc",
"rpcArgs": [{ "args": ["--mode", "rpc"] }],
"rpc": {
  "start": [
    { "record": { "type": "get_state" }, "save": "state" },
    { "record": { "type": "prompt", "message": "{input}" }, "save": "prompt" }
  ],
  "steer": { "record": { "type": "steer", "message": "{text}" } },
  "interrupt": { "record": { "type": "abort" } },
  "sessionId": "state.data.sessionId",
  "remember": [{ "when": { "type": "message_end", "message.role": "assistant" }, "as": "assistant" }],
  "done": [
    {
      "when": { "type": "agent_settled" },
      "ok": ["assistant.message.stopReason != error", "$.aborted != true"],
      "error": "assistant.message.errorMessage"
    }
  ]
}
```

| 字段                                           | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                         | `spec`（默认，按下面的配置执行）、`codex`、`claude`。后两个用内置适配器处理审批和控制消息                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `jsonrpc`                                      | 发请求时带 `jsonrpc: "2.0"`（标准 JSON-RPC，例如 Command Code）                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `handshake`                                    | 进程起来后按顺序发的消息，例如 `initialize` 和 `initialized`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `start` / `resume` / `fork`                    | 开始一轮；续接、分叉时换成对应的动作                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `steer` / `interrupt` / `exit`                 | 插话、中断、这一轮结束前发的消息                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `compact`                                      | 压缩上下文（`features.compact` 为 `native`）：续接会话后按顺序发，最后一个回复成功就算压缩完了，不发 `start`                                                                                                                                                                                                                                                                                                                                                                                              |
| `after`                                        | 这一轮结束、交结果之前再发的请求，例如 Pi 的 `get_session_stats` 查准确的上下文占用；一般配 `optional`、`parse`                                                                                                                                                                                                                                                                                                                                                                                           |
| `asks`                                         | CLI 发来的、要用户回答的请求（Pi 扩展的确认框、选择框），见下面「要用户回答的请求」                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sessionId` / `turnId`                         | 从哪个 `save` 的回复的哪个字段取会话、轮次 id，例如 `init.result.session.id`；路径里的 `{路径}` 先换成存下的值，例如 Pi 的 `post.data.messages.{pre.data.messages.length}.entryId`（这一轮开始前有几条用户消息，结束后列表里那个位置就是这一轮自己的）                                                                                                                                                                                                                                                    |
| `unwrap`                                       | 事件外面包了一层时解开的路径，例如 `$.event`；Parser 自己能处理包装时不要写                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `remember`                                     | 记住某类记录，供 `done` 的条件使用                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `done`                                         | 收到什么样的记录算这一轮结束；`ok` / `error` 是条件或路径，`$.` 开头取当前记录，其余取 `remember` 的记录                                                                                                                                                                                                                                                                                                                                                                                                  |
| `closeDelayMs`                                 | 结束后等多久再关 stdin；期间有新输出会取消（Claude Code 插话后用）                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `defaultMaxTurns`                              | 没设置回合上限时传给 `{maxTurns}` 的默认值，0 表示不传                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `turnLimit`                                    | CLI 没有回合上限参数时由面板数：`{ "when": { "type": "turn_start" } }`，一次模型请求一条，超过设置里的回合上限就按 `interrupt` 停下，这一轮算失败并显示原因                                                                                                                                                                                                                                                                                                                                               |
| `deferSteer`                                   | 插话要等 CLI 的下一个模型请求才取走：消息立刻进对话，等它开始下一次请求再把输出另起一条                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `redirect`                                     | 插话被正在执行的命令挡着（Pi 要等这批工具跑完才取）时怎么让它马上处理：`take` 收回排着的插话（`texts` 是回复里原文列表的路径，空的说明已被取走，不打断），`stop` 停下这一轮（期间的结束记录不算结束），`then` 把插话作为新的一句交给它（`{text}`）。面板在会写东西的命令跑了 8 秒还没完时触发；只读命令（`ls`、`rg`、`git log`）等它自己跑完，卡住了才在 40 秒时停（`server/exec/redirect.ts`）。这一轮交出过插话时，结束前也用 `take` 收一次：和结束擦肩而过、CLI 不会再处理的插话按 `then` 交给它接着做 |
| `nativeAsk`                                    | 协议自己处理提问和审批，不挂面板的 MCP 提问工具                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `limitsQuery` / `skillsQuery` / `pluginSkills` | 能主动查额度、列 Skill、Skill 里包含已装插件                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `skillsDir`                                    | 列表走协议时，从哪个目录读用户 Skill；面板自带的 Skill 不按 CLI 安装，统一放在 `~/.agents/skills`                                                                                                                                                                                                                                                                                                                                                                                                         |
| `queryArgs`                                    | 只查额度 / Skill、不跑任务时的启动参数，例如 Codex 的 `["app-server"]`                                                                                                                                                                                                                                                                                                                                                                                                                                    |

一条消息的写法：

- JSON-RPC：`{ "method": "turn/start", "params": { "input": "{input}" } }`
- 记录流：`{ "record": { "type": "prompt", "message": "{input}" } }`
- `notify: true` 只发不等回复；`save` 把回复存起来给后面的字段和条件用；`if` 可以按 `resume`、`fork`、`model` 等条件跳过
- `optional: true` 失败了（回复报错、超时）也不影响这一轮；`parse: true` 把回复也交给输出映射（`output.events` 里按 `type`、`command` 认）
- 回复里的错误两种写法都认：JSON-RPC 的 `error.message`，记录流的 `success: false` 加一句 `error`（Pi）

占位符：`{input}`、`{text}`（插话内容）、`{model}`、`{effort}`、`{resume}`、`{maxTurns}`、`{cwd}`。整条就是占位、运行时又没有值时，这个字段不传。
命令行参数规则（`args` / `rpcArgs`）另外还能用 `{title}`：对话的标题，例如 Pi 的 `--name`，在 CLI 自己的会话列表里认得出是哪个对话。
条件里还能用 `noEdit`：这一轮不许改文件（还没开独立分支的对话；父对话不改文件只靠角色说明，不关工具），能按名字关工具的 CLI 用它把改文件的工具关掉，例如 Pi 的 `--exclude-tools edit,write`（Pi 的多个 `--exclude-tools` 只有最后一个生效，要和权限的那条合在一起写）。

### 要用户回答的请求 `asks`

带 `id` 和 `method` 的记录是 CLI 发来的请求。按 `when` 认出来的交给页面的提问卡片，用户的选择按模板回给 CLI；
没对上的请求当普通记录交给输出映射（例如 Pi 扩展的 `notify` 显示成一行提示，`setStatus` 这类不显示）。

```json
"asks": [
  {
    "when": { "type": "extension_ui_request", "method": "confirm" },
    "kind": "tool",
    "title": "$.title",
    "detail": "$.message",
    "allow": { "type": "extension_ui_response", "id": "{id}", "confirmed": true },
    "deny": { "type": "extension_ui_response", "id": "{id}", "confirmed": false }
  },
  {
    "when": { "type": "extension_ui_request", "method": "select" },
    "title": "$.title",
    "options": "$.options",
    "allow": { "type": "extension_ui_response", "id": "{id}", "value": "{answer}" },
    "deny": { "type": "extension_ui_response", "id": "{id}", "cancelled": true }
  }
]
```

`kind` 是卡片的样子（`command`、`file`、`tool` 是允许 / 拒绝，`question` 是选项或填写，默认 `question`）；
`title`、`detail`、`options` 写 `$.路径` 取请求里的字段；模板里 `{id}` 是请求的 id，`{answer}` 是用户选的或填的内容。
对话的「提问」开关关着时，问题类的请求直接按 `deny` 回，让 CLI 自己决定。

## 输出解析 `output`

内置解析器写名字（`"commandcode"`）；其他的写事件映射：按顺序找第一条 `when` 全部相等的规则，按 `emit` 产生面板的事件。

```json
"output": {
  "format": "ndjson",
  "events": [
    { "when": { "type": "init" }, "emit": [{ "type": "session", "id": "$.session_id" }, { "type": "usage", "model": "$.model" }] },
    { "when": { "type": "message", "role": "user" }, "emit": [] },
    { "when": { "type": "message", "delta": true }, "emit": [{ "type": "text_delta", "text": "$.content" }] },
    { "when": { "type": "tool_use" }, "emit": [{ "type": "tool", "name": "$.tool_name", "id": "$.tool_id", "input": "$.parameters" }] },
    { "when": { "type": "tool_result" }, "emit": [{ "type": "tool_result", "id": "$.tool_id", "output": "$.output", "failed": "$.status != success" }] },
    { "when": { "type": "result" }, "emit": [{ "type": "result", "ok": "$.status == success", "error": "$.error.message" }] }
  ]
}
```

`when` 的键也可以是 `a.b` 这样的路径（例如 Pi 的 `"assistantMessageEvent.type": "text_delta"`）。
`emit` 里的值：`$.a.b` 取事件里的字段（数组用 `-1` 取最后一项，如 `$.messages.-1.stopReason`），`$.a == x`、`$.a != x` 比较，其余是字面值。
同一轮里出现多个 `result` 时以最后一个为准。常驻 RPC 的结束条件写在 `rpc.done`，不靠 `result`：例如 Pi 以 `agent_settled` 结束，
`agent_end` 只是一个底层 agent 跑完了（后面可能还有自动重试、压缩、插话），配置里不映射它。面板认识的事件：

| 事件                  | 字段                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`             | `id`：会话 id，继续对话时作为 `{resume}`                                                                                                                                                                                                                                                          |
| `text_delta` / `text` | `text`：回复的一段（流式）/ 一整段                                                                                                                                                                                                                                                                |
| `gen`                 | `text`：模型在生成、但不显示的输出（流式的工具参数），只算进实时速度                                                                                                                                                                                                                              |
| `thinking`            | `text`、`delta`；`final: true` 表示这段思考结束时的整段：推过增量就不再发，没推过（有的 Responses 中转只在结束时给）才用它                                                                                                                                                                        |
| `tool`                | `name`、`id`、`input`：按工具名认出读文件、改文件、跑命令、搜索、网页等，`input` 里的 `command`、`file_path`、`content`、`old_string`/`new_string` 会显示出来                                                                                                                                     |
| `tool_result`         | `id`、`output`、`error`、`failed`、`exitCode`：命令的退出码（CLI 报得出时给，例如 Pi 的 `$.result.structuredContent.exit_code`），排查失败时要看它，不要凭空补 0                                                                                                                                  |
| `usage`               | `context`、`window`、`model`、`addInput`、`addOutput`、`addCacheRead`、`addCacheWrite`、`addCost`；`addInput` 不含缓存（只算未命中的）时写 `inputExcludesCache: true`，面板加上缓存再记                                                                                                           |
| `error`               | `message`：只记下来，这一轮失败时一起显示                                                                                                                                                                                                                                                         |
| `notice`              | 不影响结果、但用户应该看到的情况，显示成回复里的一行：`text`、`failed`；或者给 `kind` 由面板按界面语言拼文字：`retry`（`attempt`、`maxAttempts`、`delayMs`、`error`）、`retry_failed`（`attempt`、`error`）、`compact_failed`（`error`，为空时不显示）、`tools_failed`（`error`，面板工具没接上） |
| `retry_ok`            | 自动重试成功（`attempt`）：只用来把前面那张「正在重试」收成「已恢复」，不额外占一行提示                                                                                                                                                                                                           |
| `compacted`           | 压缩了上下文：`before`、`context` 是压缩前后的 token 数，两个都没有时不算压缩过（例如压缩失败）                                                                                                                                                                                                   |
| `request_start`       | 开始一次模型请求：CLI 没有插话协议时，登记给 `read_user_notes` 的补充在它真正被读到时把输出另起一条（Command Code 用 `model_request_start`，Pi 用 `turn_start`）                                                                                                                                  |
| `files_changed`       | 改了文件，面板去 git 里重新读改动                                                                                                                                                                                                                                                                 |
| `result`              | `ok`、`error`：这一轮结束                                                                                                                                                                                                                                                                         |

## 面板的工具 `mcp`

UI 设计的 AI 通过面板提供的工具（MCP，Streamable HTTP）改设计，没有提问通道的 CLI 也通过它向用户提问（`ask_user`）、
取用户在执行中补充的要求（`read_user_notes`，见 `features.notes`）。
对话的保活由面板自己做，不靠模型调用工具：一轮回复结束、对话页还开着时面板先不关进程，用户再发消息时
在同一个进程里开下一轮（Claude Code 再写一条不带 `priority` 的 user 消息，Codex 在同一个 thread 再发 `turn/start`，
面板不用结束再 `--resume`）。能不能保活只看 `features.keepAlive`
和是不是对话（压缩、审查这类操作除外）；`rpc.nativeAsk` 只决定提问、审批走 CLI 自己的协议还是面板的 MCP 工具，不影响保活。
切走对话页后有宽限（设置里的「离开对话后保留多久」，默认 60 分钟；环境变量 `AGENT_PANEL_PRESENCE_GRACE_MS` 优先，测试用），
过了宽限进程正常退出。没看过的回复也共用这一段宽限（2026-11-02 去掉了单独的「未读回复保留」`unreadGraceMinutes`）：
橙点只有用户点开才会消，不收的话进程永远挂着。
**这段宽限只管「回复完停在等下一句」的空闲会话**：这一轮还在跑的对话（CLI 正在回话、在等它派出的子任务、在等后台命令结果、名下还有活着的子对话）不按时间回收，不管页面开着还是已经切到后台。判定在 `shared/task.ts` 的 `keepAliveBusy`（纯函数），配 `server/tasks/keepalive.ts` 的 `keepAliveBusy(id)` 补上后台命令数、名下子对话数。`server/presence.ts` 到了宽限先问这一句：还在跑就只记一个待回收标记（不重排定时器：宽限期可以设成 0，会自旋），等这一轮结束由 `resetIdleCountdown` 从那一刻算满一整段。
保活会话没有全局数量上限（2026-11-02 取消了「同时保活的会话上限」`keepAliveLimit`）：空闲进程只按上面的宽限回收，量大时进程会更多，内存紧张时改「离开后保留」即可。
已知限制（都不影响主行为，改这块时留意）：

- 待回收标记只在「这一轮结束」（`onKeepAlive`）时补排。若父对话是因为名下有子对话在跑被叫停、而子对话结束时没有东西唤醒它（父计划里没等这一步），这个空闲会话的宽限会失效，要等用户再点开才收。兜底可在子对话 live 记录消失时给父对话补一次 `rescheduleIfUnwatched`。
- 「名下有子对话」按 `live` 里所有子对话算，不区分子对话本身就是停在等下一句的空闲（保护来自 `stopTask → closeChildren`，否则会连带停掉子对话）。
  设置里的「自动回收闲置 Agent」（`reclaimIdleCli`）关掉后不再按上面的宽限计时回收，空闲进程会一直留着。
  回收后用户再打开会冷启动一次，会话靠 `--resume` 续接，代价是几秒钟。
  面板被强杀（`taskkill /F`、崩溃）时来不及停的 CLI 记在数据目录的 `run/cli-pids/<面板 pid>.json`（每个面板实例一份，退出时只删自己那份），下次启动只清理命令行里认得出是面板起的
  （面板自己的 `cache/cli-run/` 临时目录、MCP 桥接参数），用户自己跑的 `pi`、`codex` 命令行没有这些痕迹，不会被碰。
  任务已经收口（完成 / 已停下）却还留着的 CLI 由启动后的兜底回收清掉（`server/exec/orphans.ts` 的 `reapSettledTaskClis`，之后每小时一次）。
  `wait_user_message` 工具仍然提供，模型主动调用时这一轮不结束、等用户下一句；
  但正常轮次不需要它，模型没调用也能保活。`tools/list` 里多了这个工具，不算插话协议。
  打开一个已有会话的对话页不会启动 CLI：只有真正发消息时才按当前选择启动这一轮。
  代价是第一条消息要等 CLI 启动和会话加载，换来的是「只是看一眼」不会在后台起一堆进程。
  `args` 是加在命令行上的参数，`files` 是写进这一轮工作目录的配置文件（路径 → JSON 内容，用完还原）；内容是字符串时原样写成文本文件。
  里面的 `{name}` 换成工具名（如 `design`），`{url}` 换成工具地址，`{dir}` 换成面板这一轮自己的临时目录（数据目录的 `cache/cli-run/` 下，绝对路径，用完删掉）。
  路径以 `{dir}/` 开头的文件写进这个临时目录，不进用户的项目。文件写不成时（目录只读、被占用）参数也不加，这一轮没有面板的工具，
  对话里会显示一行提示，但照常执行。
  `vars` 是模板里可以填的变量（数值或字符串，例如 Pi 桥接的 `stepTimeout` / `attempts`）：生产值写在定义里，
  脚本不自己写死；测试调 `mcpConfig` 时传覆盖值换成小值，不用真等到生产的秒数。`{name}` / `{url}` / `{dir}` 先填，不会被 `vars` 覆盖。

`extras` 是按设置开关注入的额外扩展：每一项写 `option`（设置里那个开关的 id，条件是 `opt.<id>`）、`args` 和 `files`，
只有开关打开时才写文件、加参数；关着时文件根本不写，CLI 里也就不会注册这些工具。
不传 `options` 的调用（例如 UI 设计那一轮）按关着处理。内置 CLI 现在没有用到它（Pi 以前的面板自建联网搜索是这样接的，已经删掉）。

提问要一直等到用户回答，可能很久（用户不在电脑前）。这条请求面板用 SSE 流式响应，等待期间定期发心跳，
HTTP 客户端不会因为长时间没有数据而断开；CLI 自己的 MCP 请求超时还要在配置里放宽，否则等不到用户回答。
下面以用户自己加的一个文件型 CLI 为例（路径和超时键的写法按那个 CLI 自己的配置格式给）：

```json
"env": { "MCP_TOOL_TIMEOUT": "86400000" },
"mcp": {
  "files": {
    ".custom/settings.json": { "mcpServers": { "{name}": { "url": "{url}", "timeout": 86400000 } } }
  }
}
```

Command Code 读环境变量 `MCP_TOOL_TIMEOUT`（毫秒），配置文件里的写法按 CLI 自己的格式给（上例是 `mcpServers.<名字>.timeout`）；
Pi 的桥接脚本用 Node 自己的 http 客户端，没有这一步。

也可以写一个扩展做桥接：`shared/clis/pi.json` 把面板的工具交给 Pi 用的是一个扩展脚本 `{dir}/agent-panel-{name}.ts`，
启动时从 `{url}` 读工具列表，注册成 Pi 自己的工具（直接声明给模型），调用时转发过去，用 `-e` 按绝对路径加载。
扩展加载有一份总预算 `LOAD_BUDGET_MS = 10000`，握手 `initialize` 和列工具 `tools/list` 共用它：每一步单次最多
`STEP_TIMEOUT_MS = 4000`、最多试 `STEP_ATTEMPTS = 2` 次（超时再试一次），但两步加起来不超这份预算
（这三个值在 `shared/clis/pi.json` 的 `mcp.vars` 里：`loadBudget` / `stepTimeout` / `attempts`，模板里是
`{loadBudget}` / `{stepTimeout}` / `{attempts}` 占位符，测试注入小值）。整体不能调大：
Pi 启动时会等扩展加载完才读 stdin，拖长会让面板那边看到「`get_state` 没有响应」。面板忙时（压缩上下文、写大对话）
`tools/list` 会晚几秒才回，一次没等到就整轮丢掉全部面板工具，模型报 `Tool set_plan not found`，只能退化成用普通命令跑验证。
最坏 10 秒，要留在 `get_state` 的默认超时（`server/exec/rpc/session.ts` 的 `REQUEST_TIMEOUT_MS = 15000`）之内，
并留 5 秒给 Pi 冷启动、读 stdin 和回包；两边顶到同一条线上，「工具没挂上」就变成「`get_state` 没有响应」，一样用不了面板工具。
高负载时这 15 秒仍会被挤爆（进程还活着、`stderr` 空）：这种环境性超时由 runner 自动重试一次，
重试轮的请求超时放宽成 `REQUEST_TIMEOUT_MS + mcp.vars.loadBudget`（现为 25 秒），仍然失败才报错（见 `modules/server-exec/bugs/pi-rpc-env-stall-retry.md`）。
这层关系由 `server/exec/pi-rpc.test.ts` 里按定义算最坏加载时长的那条用例守着（断言 `mcp.vars.loadBudget` 和 `mcp.vars.stepTimeout × mcp.vars.attempts <= mcp.vars.loadBudget`）。
任一处失败时这一轮没有面板工具、照常执行：界面一行 `tools_failed` 提示 + 日志一条 warn（任务、步骤、CLI）。
列到了但清单是空的（一个工具都没有）也算失败，走同一条提示，不静默注册 0 个工具——工具全丢时不能只让模型自己写一句「工具不可见」，用户从界面上要看得到原因。
注册前还核对身份无关的 `get_status`、`send_message`、`read_messages`（主对话、子对话、子任务、工作流节点都有），
缺任何一个都上报「面板的工具清单不完整，缺 …」；这项核对只对服务名是 `panel` 或以 `agent-panel` 开头的扩展做，
UI 设计的服务名是 `design`，它的工具本来就不含这三个。

Pi 1.3 自己也支持 MCP（`~/.pi/agent/mcp.json`，项目里的 `.pi/mcp.json` 要先信任项目），用户自己的 MCP 服务器通过 `mcpStore`
出现在「MCP 工具」页、写进 Pi 自己的 `mcp.json`。面板的工具仍然走扩展：Pi 的 MCP 工具默认是 `codemode` 暴露（不直接声明给模型），
而项目里的配置受「项目信任」管控，print / json / rpc 模式不会弹信任提示；`-e` 显式加载的扩展不受这两点影响。

### 联网搜索

面板不自己做联网搜索，各 CLI 用自己的：Claude Code 的 `WebSearch` / `WebFetch`、Codex 的 `web_search`、Command Code 的 Web 工具都照常开着
（Claude Code 的 `--disallowedTools` 里不能出现这两个）。Pi 本身没有联网搜索，靠插件：设置里 Pi 的「插件管理」默认列出
`npm:pi-web-access`（`web_search` / `fetch_content`，不填密钥也能搜），用户点一下就装，见下面「插件」。
输出解析按工具名认出搜索和打开网页（`server/exec/parsers.ts` 的 `genericTool`），插件一次搜几个词、开几个网址（`queries` / `urls`）时都写进标签。

## 能力 `features`

| 字段             | 说明                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compact`        | 压缩上下文：`native` 走协议（常驻 RPC 的 `rpc.compact`，Pi 的 `compact` 命令，原地压缩、会话不变）；`slash` 发 `/compact`；`summary`（默认）让它写摘要，下一轮开新会话带上                                                                                                                                                                                                                  |
| `modelSwitch`    | 会话中途能换模型：对话里换了模型仍然续接原来的会话（Pi 的模型是每次启动的参数，会话里可以混用）；默认换模型就开新会话带上对话记录                                                                                                                                                                                                                                                           |
| `resumeAnyDir`   | 会话能在别的目录里续接：中途开了独立分支（`begin_edit`）、换了工作目录仍然续接原来的会话，之前读过的代码和调研都留在会话里、前缀缓存也大多命中；默认按「会话按目录存」处理，换了目录就开新会话带上对话记录。Claude Code 开（2.1.316 实测按会话 id 全局找）；Pi 换了目录会停下来问要不要分叉，不能开                                                                                         |
| `fork`           | 分叉、撤回对话：`before` 能从任意一轮分叉（每轮记下自己的 id，见 `rpc.turnId`；续接原会话后按 `rpc.fork` 里带 `if: forkBefore` 的动作分叉到那一轮之前，Pi 是 `fork` 命令的 `entryId`）；`turn` 能截到某一轮（Codex，内置适配器用轮次 id）；`end` 能截到某条回复（Claude Code，参数里用 `{forkEnd}`）；`latest` 只能从最后分叉（配合 `fork` 条件的参数）；`none`（默认）带上对话记录开新会话 |
| `autoCompact`    | 自动压缩：`config` 把 token 数写进参数（规则里用 `{autoCompactTokens}`，Codex）；`env` 用环境变量 `autoCompactEnv` 告诉 CLI 百分比；`panel`（默认）面板在一轮结束后压缩                                                                                                                                                                                                                     |
| `review`         | 审查改动：`native` 走 CLI 自己的审查模式（Codex，内置适配器）；`prompt`（默认）按审查要求跑一轮                                                                                                                                                                                                                                                                                             |
| `limits`         | 账号额度：`query` 能主动查（配合 `rpc.limitsQuery`，Codex）；`push` 执行时 CLI 才报告（Claude Code）；`none`（默认）没有                                                                                                                                                                                                                                                                    |
| `limitArgs`      | 设置里手动改的上限哪几项写成了参数（`context`、`maxOutput`，规则里用 `{contextWindow}`、`{maxOutput}`），例如 Codex 的 `model_context_window`                                                                                                                                                                                                                                               |
| `slash`          | 会话里认识「/命令」「/Skill」，原样发过去；默认面板把命令文件、Skill 展开成普通要求                                                                                                                                                                                                                                                                                                         |
| `nativeCommands` | 会话里自己就有的内置命令（例如 `init`）：面板的同名内置命令原样发过去，不再展开；其他内置命令和「所有 Agent」的命令都由面板展开                                                                                                                                                                                                                                                             |
| `steer`          | 执行中能插话。常驻 RPC 在 `rpc.steer` 里写要发的消息；一次性输出的 CLI 用不了，改用下面的 `notes`                                                                                                                                                                                                                                                                                           |
| `notes`          | 没有插话协议，但能用面板的 MCP 工具 `read_user_notes` 取执行中的补充（需要 `mcp`）：用户在它执行中发的要求直接记进对话、登记给它，模型取走时交给它；这一轮结束还没取走的，面板立刻开新一轮接着处理；对话页开着时还会挂 `wait_user_message`，回复完停在同一个进程里等下一句                                                                                                                  |
| `limitEnv`       | 设置里三档模型手动改的上下文窗口、最大输出用哪个环境变量传给 CLI，如 `{"context": "X_MAX_CONTEXT", "maxOutput": "X_MAX_OUTPUT"}`；不写表示 CLI 不接受，界面上会说明                                                                                                                                                                                                                         |
| `longContext`    | 长上下文要靠模型名后缀开（只在 API 方式下）：这一轮的上下文窗口（手动设的或按映射 / 模型目录自动算的）不小于 `min` 时，交给 CLI 的模型名加上 `suffix`，CLI 报回来的模型名去掉后缀再用。Claude Code 写 `{"suffix": "[1m]", "min": 1000000}`：它认得出的自家模型只按模型名定窗口，不看 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（2.1.317 实测）                                                       |
| `limitFile`      | 或者写进 CLI 的配置文件（账号方式下用；API 方式由 `auth.api.modelLimits` 写），只在这一轮里加上、结束后还原：`file`、`at`（`{provider}`、`{model}` 是模型 ID「provider/model」的两段，Pi 是 `providers.{provider}.modelOverrides.{model}`）、`context`、`maxOutput` 是键名                                                                                                                  |

设置里「自动压缩上下文」这一项的默认值是 70%（`shared/schema.ts` 的 `AUTO_COMPACT_DEFAULT`），0 表示按 CLI 自己的规则；
老设置里存着的 0 在读取时迁成 70（按 `Settings.defaultsVersion` 只做一次，见 `server/settings.ts`）。

审批：非交互模式下 CLI 不能请用户确认，用权限选项控制它能做什么（例如用 `--approval-mode` 这类启动参数）。
Pi 本身没有审批，权限用 `--tools +grep,+find,+ls`（在默认工具上补搜索）加 `--exclude-tools` 去掉命令或写文件的工具；
不用 `--tools` 白名单，白名单会把面板桥接的工具（提问、编排）一起挡掉。用户装了带确认框的 Pi 扩展（例如 permission-gate）时，
确认框通过 `rpc.asks` 交给页面。

## 插件 `packages`

CLI 有自己的包管理（例如 `pi install`）时，设置的 CLI 页会多一组「插件管理」（Pi 叫扩展包）：

| 字段                   | 说明                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `file` / `key`         | 已装的包记在哪个 JSON 配置文件的哪个数组里，每项是来源字符串，或带 `source` 字段的对象；直接读，不跑命令 |
| `install` / `remove`   | 装、删的参数，`{source}` 是包的来源                                                                      |
| `update` / `updateAll` | 更新一个、全部更新的参数，不写就不显示按钮                                                               |
| `placeholder`          | 来源输入框的示例                                                                                         |
| `env`                  | 装、删、更新时额外的环境变量，排在最后盖过设置开关带的（Pi 写 `PI_OFFLINE: ""`，见下）                   |
| `recommended`          | 推荐的包，列在最前面一键安装：`source`、`name`、`desc`，可选 `note`（装完还要做什么）、`url`（介绍页）   |

配置里相对路径的来源是相对配置文件写的，面板交给命令前换成绝对路径（Pi 从别的目录跑 `pi remove ../x` 会找不到）。命令的输出原样显示，失败时用户能看到原因。

Pi 的「离线运行」开关默认开着、带 `PI_OFFLINE=1`：Pi 在离线模式下 `pi update` 直接跳过、照样退出码 0，用户看到「成功」其实没更新。
所以 `packages.env` 把它清成空串（Pi 只认 `1` / `true` / `yes` 是离线），执行对话时照旧离线（`server/cli-packages.ts` 的 `packageCommandEnv`）。

推荐的包装没装按来源去掉版本号比（`shared/cli-spec.ts` 的 `packageIdentity`，和 Pi 自己认包的方式一致：`npm:<包名>`、`git:<主机>/<路径>`），
装的是 `npm:x@1.2.0` 也算装了推荐里的 `npm:x`。推荐的 `name` / `desc` / `note` 是界面文案，英文写进同一个定义的 `i18n.en`（`shared/cli-spec.test.ts` 会查）。
挑推荐的标准：在面板的 RPC 模式下能用（不靠终端界面）、和面板自己的机制不重复（子 Agent、提问、计划、MCP 都由面板管，不推荐这类插件）、装完不用改配置就能用或在 `note` 里写清楚要做什么。
Pi 现在推荐四个：`pi-web-access`（联网搜索，第一个）、`pi-web-search`（用模型服务商自带的搜索，和前者二选一）、`cc-safety-net`（拦截危险命令和读机密文件）、`@narumitw/pi-lsp`（语言服务器诊断）。

## 账号登录 `auth`

面板跑 `auth.login` 打开浏览器登录，成功后把 `auth.home` 下的 `auth.files`、`auth.fields` 和 `auth.keychain` 存成一个账号。
判断登录成功默认看**凭据有没有变**（登录前后各读一次，变了就算成功；登录后不自己退出的 CLI 也能判对），
进程结束时再比一次，没变就报「没有完成登录」；标了 `loginAlreadyLoggedIn` 的 CLI 已登录时不改凭据文件，另按下面那行判。
面板写 CLI 自己的配置文件（账号字段、API 注入、模型表、全局 MCP 工具）一律走 `server/cli-config-write.ts`，新建和覆盖都收到 `600`（里面常有 API key；Windows 跳过）。

| 字段                   | 说明                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                | 登录的命令行参数（会打开浏览器）；不写表示这个 CLI 不能在面板里登录                                                                                                                                      |
| `loginAlreadyLoggedIn` | 已经登录着时再跑登录命令会直接说「已登录」、以退出码 0 退出、**不改凭据文件**的 CLI（Command Code 的 `cmdc login` 输出 `Already logged in`）写 `true`：这时退出码 0 且读得到凭据就算成功，不看凭据变没变 |
| `loginStdin`           | 登录时从 stdin 写进去的内容（要确认的 `y` 之类）                                                                                                                                                         |
| `loginEdits`           | 登录前先改的配置（例如先选登录方式），登录完不还原                                                                                                                                                       |
| `home` / `files`       | 凭据目录（`~` 是用户目录，`${ENV:-默认值}` 先取环境变量）和里面的凭据文件                                                                                                                                |
| `fields`               | 其他 JSON 文件里属于账号的键（例如 Claude Code 在 `.claude.json` 里记着账号）                                                                                                                            |
| `keychain`             | macOS 钥匙串里的条目名                                                                                                                                                                                   |
| `identity`             | 从凭据里认出是哪个账号（邮箱）的方式；`none` 表示认不出，用保存时起的名字                                                                                                                                |
| `accountNote`          | 账号区顶部的提醒（例如这个 CLI 对账号类型的限制），界面文案的英文写 `i18n.en`                                                                                                                            |

CLI 的输出在存进 `job.output` 之前会清掉 ANSI 转义（`shared/ansi.ts` 的 `stripAnsi`）：CLI 发现标准输出接的是终端就上色，
网页里 ESC 被吞掉会只剩 `[32m` 这种残码，而同一份文本还要进报错文案、交给「AI 处理」排查。

## 凭据检查 `auth.check`

`{ "args": ["auth", "check", "--json", "--provider", "{provider}"] }`：设置的账号区按三档模型和默认模型里用到的提供方（模型 ID「provider/model」的前一段）
各跑一次，读输出 JSON 里的 `status`（等于 `ready` 的值算可以用）、`reason`、`authType`，字段名可以用同名的键改。

## 把 API 交给 CLI `auth.api`

设置里给 CLI 选了一个 API 后，面板在**保存设置时**就会按 `auth.api` 的规则写进 CLI 自己的配置（执行前还会再写一次，保证配置没被别的工具改掉）。
模型下拉只列这个 API 里配的模型，并按当前协议过滤后缀：`-anthropic`、`-responses`、`-chat`/`-completions` 只显示对应协议的，不带后缀的通用模型所有协议都显示；换协议时同一个模型会自动换到对应后缀。

| 字段                       | 说明                                                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocols`                | 能接受哪些协议的 API                                                                                                                                                                                                        |
| `defaultProvider`          | API 没有指定 provider 时，写进 CLI 配置的 provider 名，默认 `agentpanel`                                                                                                                                                    |
| `modelSource`              | `api`（默认）用全局 API 的模型；`cli` 也从 CLI 读取这些模型的上下文和强度，但列表仍只保留 API 里配的模型                                                                                                                    |
| `modelPrefix`              | 模型 ID 的 provider 前缀模板，例如 `{provider}/`；写进 provider 配置时会把重复的前缀去掉，执行旧的无前缀模型 ID 时会补上                                                                                                    |
| `env` / `args`             | 只在 CLI 只能通过环境变量/参数接收 API 时用；能写配置文件的优先写 `edits`，执行时不再重复传 API 和密钥                                                                                                                      |
| `edits`                    | 切到 API 时改的配置文件，保存设置时写；`format` 可以是 `json`（默认）、`toml`、`env`；`merge: true` 时对象递归合并，保留已有配置                                                                                            |
| `accountEdits`             | 切回账号时还原的配置文件                                                                                                                                                                                                    |
| `wire`                     | 协议在 CLI 配置里的写法，用 `{wire}` 引用                                                                                                                                                                                   |
| `baseUrl`                  | 协议 → 这个 CLI 要的接口地址写法，`{root}` 是去掉末尾 `/v1`、`/v1beta` 的地址：Anthropic SDK 自己拼 `/v1/messages`（Claude Code、Pi 写 `{root}`）；没写的协议原样用                                                         |
| `thinkArgs`                | API 方式下这一轮带了思考强度（不是 `off: true` 那一档）时加的参数；Codex 对不认识的第三方模型默认不发 reasoning，靠 `model_supports_reasoning_summaries=true` 打开                                                          |
| `pruneProviders`           | API 方式下清掉同一地址和密钥的旧 provider，只留正在用的；不同接口的 provider 不动，不写不处理                                                                                                                               |
| `requireBaseUrl`           | 配置文件里每个 provider 都必须带接口地址时（Pi 的 `models.json`）设为 `true`：地址为空（用户没填、厂家也没有默认地址）时不写 `edits`，并把面板之前写进去的 provider 清掉，免得 Pi 继续用旧地址                              |
| `dropEmptyBaseUrl`         | 写配置前删掉值为空的 `baseUrl` 键（provider 层和 `models` 条目层）：Pi 的 `models.json` 只在 `baseUrl` 出现时要求至少 1 个字符，一条空地址就让整份文件失效；只删空键，provider、models 和用户配置都保留                     |
| `pruneModels`              | API 方式下 provider 的 models 只保留 API 里配的模型，旧模型删掉；不写不处理                                                                                                                                                 |
| `modelEfforts`             | CLI 只认模型条目自己声明的强度时（Command Code 的 `reasoningEfforts`），按模型目录写回这个键；目录里没有的模型不动                                                                                                          |
| `modelReasoning`           | CLI 只认模型条目自己声明的「能不能调思考强度」时（Pi 的 `reasoning` 是布尔），目录里有强度的模型写 `true`，下拉才不止一档                                                                                                   |
| `modelReasoning.levelsKey` | 每档强度的取值表写进哪个键（Pi 的 `thinkingLevelMap`）：CLI 的每一档（关闭除外）模型支持写同名值、不支持写 `null`；Pi 不写这张表时不认 xhigh / max                                                                          |
| `modelReasoning.known`     | 模型目录里没有的模型再查 CLI 自带的模型数据（`pi-ai`：Pi 依赖的 pi-ai 的 `dist/providers/data/*.json`），按模型名取 `reasoning` 和取值表；不写时目录外的模型不动，Pi 当成不能思考，Responses / Anthropic 协议下就不请求思考 |
| `modelDefaultEffort`       | CLI 启动时按模型取默认强度的表（Pi `settings.json` 的 `modelThinkingLevels`）：`file`、`at`、`key`（如 `{provider}/{model}`）；写 API 设置里配的默认强度，没配用目录默认值                                                  |
| `modelLimits`              | CLI 只认模型条目自己声明的上下文窗口时，按模型目录写回这个键；`maxOutputKey` 是最大输出写进哪个键，不写表示不接受                                                                                                           |
| `modelInput`               | CLI 靠模型条目自己声明的「能接收哪些输入」决定要不要把图片发给模型时（Pi 的 `input`），按模型目录的 `images` 写回这个键；`withImage` / `withoutImage` 是支持和不支持图片时写的值，目录里没登记 `images` 的模型不动          |

已经能写配置文件的 CLI（Codex、Command Code、Pi、Claude Code）把 API 地址和密钥都写进各自的配置，执行时的 `env` / `args` 只留模型、思考强度和沙箱等运行参数。

一个 API 可以同时支持几种协议（`ApiConfig.endpoints`：协议 → 这种协议的接口地址，密钥共用；为空的老配置只有 `protocol` / `baseUrl` 那一种）。
CLI 选 API 时再选协议（`CliSettings.apiProtocol`），`shared/accounts.ts` 的 `cliApi` 按 `auth.api.protocols` 取两边都支持的那种、换成那种协议的地址，
`cliSettings` 返回的 `api` 已经是换好的，模板里的 `{protocol}` / `{wire}` / `{baseUrl}` 都按它填。没选过协议时先用 API 的主协议，再取第一种两边都支持的。
改了 API 不会自动写进 CLI 的配置文件：「API 配置」页的「一键更新」写进所有在用它的 CLI，CLI 页的「更新」只写这一个（`server/accounts.ts` 的 `applyCliApi`，页面上的选择和已保存的对不上时拒绝）。
`{provider}` 来自 API 的 `provider`：识别到的 API 用 CLI 配置里的键（例如 `providers.tokenapi` 的 `tokenapi`），新建的从 API 名称生成。
`{models}` / `{modelList}` 写进 provider 配置时会去掉模型 ID 上已有的 `{provider}/`，避免变成 `tokenapi/tokenapi/...`。

## 识别 CLI 自己配的 API `auth.apiSources`

设置 → CLI 里的「API 配置」页和各个 CLI 页会读各个 CLI 自己的环境变量和配置文件，把里面配好的接口地址、密钥和模型列出来，用户确认后存进全局的 API 列表，
别的 CLI 也能选用。读哪里写在 `auth.apiSources` 里，每一项是一个来源：

| 字段                   | 说明                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `file`                 | 配置文件；不写表示看环境变量（系统的加上设置里这个 CLI 的）                                   |
| `format`               | `json`（默认）、`toml` 或 `env`（`.env` 文件）                                                |
| `at` / `each`          | 配置所在的键（`a.b`）；`each` 为 `true` 时下面每个子键各是一个 API（例如 `providers.<名字>`） |
| `protocol` / `wire`    | 默认的协议，和「协议写法 → 协议」的对照；不写 `wire` 时用 `auth.api.wire` 反查                |
| `wireKey`              | 协议写法的键                                                                                  |
| `baseUrl`              | 接口地址的键，都没值时用 `defaultBaseUrl`                                                     |
| `apiKey` / `bearerKey` | 密钥的键；`bearerKey` 的用 `Authorization: Bearer` 发                                         |
| `keyEnv`               | 值是环境变量名的键（例如 Codex 的 `env_key`）                                                 |
| `models` / `name`      | 模型（字符串、数组、`[{ "id" }]` 或以模型名为键的对象都认）和名字的键                         |

键都按顺序取第一个有值的；值写成 `$NAME`、`${NAME}`，或正好是一个设置了的环境变量名时取那个环境变量。面板自己写进去的 `agentpanel` 不算。

## 关掉思考

强度下拉里的「关」只给能真正让接口不思考的 CLI，定义里标 `"off": true`：

- **Codex**：`none`，传 `-c model_reasoning_effort="none"`，turn/start 也带 `effort: "none"`。0.166 用 `codex exec` 用本机假接口抓过，发给 Responses 接口的是 `reasoning: {"effort": "none", ...}`；
  这一档不加 `thinkArgs`（不打开思考摘要）。
- **Pi**：`off`，传 `--thinking off`。
- **Claude Code**：`off`，没有命令行参数，这一档不传 `--effort`，靠 `env`：`MAX_THINKING_TOKENS=0`（不带思考、也不加 clear_thinking 的上下文编辑）
  加 `CLAUDE_CODE_EXTRA_BODY={"thinking":{"type":"disabled"}}`（2.1.316 把这个变量的 JSON 展开在请求体最后，盖过它自己算的 `thinking`）。
  只设 `MAX_THINKING_TOKENS=0` 不够：请求里不带 `thinking` 字段，有的网关不带时默认会思考。用本机假接口抓过请求体，确认带的是 `thinking: {"type": "disabled"}`。
  用户自己在环境变量里写了 `CLAUDE_CODE_EXTRA_BODY` 时合并进去，不覆盖。

模型目录只记思考的各档、不记「关」：目录认识的模型只要能思考（`efforts` 不空），CLI 有 `off` 档时就补上这一档（`catalogEfforts`，`shared/clis.ts`），
否则选了「关」执行前会被换成最近的思考档。CLI 自己报了模型能选哪几档时（Codex 账号方式的 `supportedReasoningEfforts`）按 CLI 报的来。
